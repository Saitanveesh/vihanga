"""Bounded, local evidence from the station's receive-only telemetry paths."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import sqlite3
from datetime import datetime, timezone
from math import ceil, isfinite
from uuid import uuid4

SAMPLE_SECONDS = 1.0
RETAINED_CAPTURES = 20
RECEIVERS = ("primary", "backup")
logger = logging.getLogger(__name__)


class CaptureBusy(Exception):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def number(value):
    return value if type(value) in (int, float) and isfinite(value) and value >= 0 else None


def code(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Z0-9_]{1,70}", value) else None


def receiver_snapshot(snapshot: dict, receiver: str) -> dict:
    return {
        "status": code(snapshot.get(f"{receiver}_status")) or "UNKNOWN",
        "transport": code(snapshot.get(f"{receiver}_transport")),
        "heartbeat_fresh": snapshot.get(f"{receiver}_heartbeat_fresh") is True,
        "attitude_fresh": snapshot.get(f"{receiver}_attitude_fresh") is True,
        "age_ms": number(snapshot.get(f"{receiver}_age_ms")),
        "frame_rate_hz": number(snapshot.get(f"{receiver}_frame_rate_5s_hz")),
        "error_code": code(snapshot.get(f"{receiver}_error_code")),
        "system_id": number(snapshot.get(f"{receiver}_system_id")),
        "frames_total": number(snapshot.get(f"{receiver}_frames_total")),
        "reconnect_attempt": number(snapshot.get(f"{receiver}_reconnect_attempt")),
        "path_evidence": snapshot.get(f"{receiver}_path_evidence"),
    }


def summarize(samples: list[dict]) -> dict:
    counts = len(samples)
    metrics = {}
    for receiver in RECEIVERS:
        observed = [sample[receiver] for sample in samples]
        live = [item for item in observed if item["status"] == "LIVE"
                and item["heartbeat_fresh"] and item["attitude_fresh"]]
        ages = sorted(item["age_ms"] for item in live if item["age_ms"] is not None)
        percentiles = {f"p{p}_ms": ages[ceil(len(ages) * p / 100) - 1] if ages else None
                       for p in (50, 95, 99)}
        metrics[receiver] = {
            "configured_samples": sum(item["transport"] is not None for item in observed),
            "live_samples": len(live), "age_samples": len(ages), **percentiles,
        }

    events = []
    previous = {}
    for sample in samples:
        state = {receiver: sample[receiver]["status"] for receiver in RECEIVERS}
        state["active_source"] = sample["active_source"]
        for field, value in state.items():
            if field in previous and previous[field] != value:
                events.append({"elapsed_ms": sample["elapsed_ms"], "field": field,
                               "from": previous[field], "to": value})
        previous = state
    return {"sample_count": counts, **metrics, "events": events}


def ledger_hash(previous: str, value: dict) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(bytes.fromhex(previous) + encoded).hexdigest()


def ledger_seed(capture) -> str:
    identity = {key: capture[key] for key in ("vehicle_id", "capture_id", "started_at", "duration_seconds")}
    return ledger_hash("00" * 32, {"format": "vihanga.bench.v1", **identity})


def verify_samples(capture, samples, count, head):
    digest = ledger_seed(capture)
    for sample in samples:
        digest = ledger_hash(digest, sample)
    return len(samples) == count and digest == head


def continuity(samples):
    changes = []
    last = None
    previous_ms = None
    for i, sample in enumerate(samples):
        ms = sample["elapsed_ms"]
        if previous_ms is not None and ms - previous_ms > 2000:
            changes.append({"index": i, "elapsed_ms": ms, "state": "Observation gap",
                            "detail": f"{ms - previous_ms} ms between station samples"})
            last = None
        live = [role for role in RECEIVERS if sample[role]["transport"] and sample[role]["status"] == "LIVE"
                and sample[role]["heartbeat_fresh"] and sample[role]["attitude_fresh"]]
        source = sample["active_source"]
        state = ("Both receivers live" if len(live) == 2 else
                 f"{live[0].capitalize()} only" if live else "No live receiver observed")
        detail = [f"Viewer: {source or 'unknown'}"]
        for role in RECEIVERS:
            path = sample[role].get("path_evidence") or {}
            if path.get("diagnosis"):
                detail.append(f"{role}: {path['diagnosis']}")
        current = (state, " · ".join(detail))
        if current != last:
            changes.append({"index": i, "elapsed_ms": ms, "state": state, "detail": current[1]})
        last = current
        previous_ms = ms
    return changes


class BenchRecorder:
    def __init__(self, db, snapshot):
        self._db = db
        self._snapshot = snapshot
        self._task: asyncio.Task | None = None
        self._stop: asyncio.Event | None = None
        self._id: str | None = None
        self._closing = False
        with db() as con:
            con.execute("""CREATE TABLE IF NOT EXISTS bench_captures (
                capture_id TEXT PRIMARY KEY,
                vehicle_id TEXT NOT NULL REFERENCES vehicles(vehicle_id),
                started_at TEXT NOT NULL, ended_at TEXT,
                duration_seconds INTEGER NOT NULL, status TEXT NOT NULL
            )""")
            con.execute("""CREATE TABLE IF NOT EXISTS bench_samples (
                capture_id TEXT NOT NULL REFERENCES bench_captures(capture_id) ON DELETE CASCADE,
                elapsed_ms INTEGER NOT NULL, captured_at TEXT NOT NULL,
                payload TEXT NOT NULL, PRIMARY KEY (capture_id, elapsed_ms)
            )""")
            con.execute("""CREATE TABLE IF NOT EXISTS bench_ledger (
                capture_id TEXT PRIMARY KEY REFERENCES bench_captures(capture_id) ON DELETE CASCADE,
                sample_count INTEGER NOT NULL, head TEXT NOT NULL
            )""")
            con.execute("""UPDATE bench_captures SET status = 'INTERRUPTED',
                        ended_at = COALESCE((SELECT MAX(captured_at) FROM bench_samples s
                            WHERE s.capture_id = bench_captures.capture_id), started_at)
                        WHERE status = 'RECORDING'""")

    def list(self, vehicle_id: str) -> list[dict]:
        with self._db() as con:
            return [dict(row) for row in con.execute("""
                SELECT c.*, (SELECT COUNT(*) FROM bench_samples s
                    WHERE s.capture_id = c.capture_id) AS sample_count
                FROM bench_captures c WHERE c.vehicle_id = ?
                ORDER BY c.rowid DESC
            """, (vehicle_id,))]

    def detail(self, vehicle_id: str, capture_id: str) -> dict | None:
        with self._db() as con:
            con.execute("BEGIN")
            record = con.execute("""SELECT * FROM bench_captures
                                 WHERE vehicle_id = ? AND capture_id = ?""",
                                 (vehicle_id, capture_id)).fetchone()
            if record is None:
                return None
            rows = con.execute("""SELECT elapsed_ms, captured_at, payload FROM bench_samples
                               WHERE capture_id = ? ORDER BY elapsed_ms""", (capture_id,))
            samples = [{"elapsed_ms": row["elapsed_ms"], "captured_at": row["captured_at"],
                        **json.loads(row["payload"])} for row in rows]
            checkpoint = con.execute("SELECT sample_count, head FROM bench_ledger WHERE capture_id = ?",
                                     (capture_id,)).fetchone()
        ledger = {"format": "vihanga.bench.v1", "status": "UNSEALED", "clock": "station observation",
                  "continuity": continuity(samples)}
        if checkpoint:
            valid = verify_samples(record, samples, checkpoint["sample_count"], checkpoint["head"])
            ledger.update(status="VERIFIED" if valid else "MISMATCH", head=checkpoint["head"],
                          sample_count=checkpoint["sample_count"])
        return {"ledger": ledger, "capture": {**dict(record), "sample_count": len(samples)},
                "samples": samples, "summary": summarize(samples)}

    def start(self, vehicle_id: str, duration_seconds: int) -> dict:
        if self._closing or (self._task is not None and not self._task.done()):
            raise CaptureBusy("A station bench capture is already running")
        capture_id = uuid4().hex
        started_at = utc_now()
        with self._db() as con:
            # Recover a row left open by a write failure during finalization.
            con.execute("""UPDATE bench_captures SET status = 'INTERRUPTED', ended_at = ?
                        WHERE status = 'RECORDING'""", (started_at,))
            con.execute("""INSERT INTO bench_captures VALUES (?, ?, ?, NULL, ?, 'RECORDING')""",
                        (capture_id, vehicle_id, started_at, duration_seconds))
            seed = ledger_seed({"vehicle_id": vehicle_id, "capture_id": capture_id,
                                "started_at": started_at, "duration_seconds": duration_seconds})
            con.execute("INSERT INTO bench_ledger VALUES (?, 0, ?)", (capture_id, seed))
            self._write_sample(con, capture_id, 0, started_at, self._sample(vehicle_id))
            con.execute("""DELETE FROM bench_captures WHERE capture_id IN (
                        SELECT capture_id FROM bench_captures
                        ORDER BY rowid DESC LIMIT -1 OFFSET ?
                        )""", (RETAINED_CAPTURES,))
        self._id, self._stop = capture_id, asyncio.Event()
        clock = asyncio.get_running_loop()
        self._task = clock.create_task(self._record(
            capture_id, vehicle_id, self._stop, clock.time(), duration_seconds))
        return {"capture_id": capture_id, "vehicle_id": vehicle_id, "started_at": started_at,
                "ended_at": None, "duration_seconds": duration_seconds, "status": "RECORDING",
                "sample_count": 1}

    def _sample(self, vehicle_id: str) -> str:
        snapshot = self._snapshot(vehicle_id)
        source = snapshot.get("active_source")
        payload = {
            "active_source": source if source in ("PRIMARY", "BACKUP") else None,
            **{receiver: receiver_snapshot(snapshot, receiver) for receiver in RECEIVERS},
        }
        return json.dumps(payload, separators=(",", ":"))

    @staticmethod
    def _write_sample(con, capture_id: str, elapsed_ms: int, stamp: str, payload: str):
        con.execute("INSERT INTO bench_samples VALUES (?, ?, ?, ?)",
                    (capture_id, elapsed_ms, stamp, payload))

        checkpoint = con.execute("SELECT head FROM bench_ledger WHERE capture_id = ?", (capture_id,)).fetchone()
        if checkpoint is None:
            raise RuntimeError("Missing ledger checkpoint")
        entry = {"elapsed_ms": elapsed_ms, "captured_at": stamp, **json.loads(payload)}
        digest = ledger_hash(checkpoint["head"], entry)
        con.execute("UPDATE bench_ledger SET head = ?, sample_count = sample_count + 1 WHERE capture_id = ?",
                    (digest, capture_id))

    def _persist_sample(self, capture_id: str, elapsed_ms: int, stamp: str, payload: str):
        with self._db() as con:
            self._write_sample(con, capture_id, elapsed_ms, stamp, payload)

    def _finish(self, capture_id: str, status: str):
        with self._db() as con:
            con.execute("UPDATE bench_captures SET status = ?, ended_at = ? WHERE capture_id = ?",
                        (status, utc_now(), capture_id))

    async def _record(self, capture_id, vehicle_id, stop, started, duration):
        clock = asyncio.get_running_loop()
        deadline = started + duration * SAMPLE_SECONDS
        next_sample = started + SAMPLE_SECONDS
        status = "COMPLETE"
        try:
            while True:
                wake = min(next_sample, deadline)
                try:
                    await asyncio.wait_for(stop.wait(), max(0, wake - clock.time()))
                    status = "INTERRUPTED" if self._closing else "STOPPED"
                    break
                except TimeoutError:
                    now = clock.time()
                    if now >= deadline:
                        break
                    if now < next_sample:
                        # Some clocks deliver timer callbacks before their requested time.
                        continue
                    next_sample = now + SAMPLE_SECONDS
                    await asyncio.to_thread(self._persist_sample, capture_id,
                                            round((now - started) * 1000), utc_now(), self._sample(vehicle_id))
        except Exception:
            status = "INTERRUPTED"
            logger.exception("Station bench capture interrupted")
        try:
            await asyncio.to_thread(self._finish, capture_id, status)
        except sqlite3.Error:
            logger.exception("Unable to finalize station bench capture")

    async def stop(self, vehicle_id: str, capture_id: str) -> dict | None:
        report = self.detail(vehicle_id, capture_id)
        if report is not None and capture_id == self._id and self._task and self._stop:
            self._stop.set()
            await asyncio.shield(self._task)
            return self.detail(vehicle_id, capture_id)
        return report

    async def close(self):
        self._closing = True
        if self._task and self._stop:
            self._stop.set()
            await asyncio.shield(self._task)
