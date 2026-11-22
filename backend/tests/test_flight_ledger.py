import sqlite3
from contextlib import contextmanager

from vihanga.bench import BenchRecorder, continuity, ledger_seed


def test_capture_time_chain_and_legacy_read(tmp_path):
    @contextmanager
    def db():
        con = sqlite3.connect(tmp_path / "ledger.sqlite")
        con.row_factory = sqlite3.Row
        try:
            with con:
                yield con
        finally:
            con.close()

    recorder = BenchRecorder(db, lambda _: {})
    record = dict(capture_id="cap", vehicle_id="uav", started_at="start", duration_seconds=30)
    with db() as con:
        con.execute("INSERT INTO bench_captures VALUES ('cap','uav','start',NULL,30,'COMPLETE')")
        con.execute("INSERT INTO bench_ledger VALUES ('cap',0,?)", (ledger_seed(record),))
        for offset in (0, 1000, 4500):
            recorder._write_sample(con, "cap", offset, "stamp", recorder._sample("uav"))
    report = recorder.detail("uav", "cap")
    assert report["ledger"]["status"] == "VERIFIED"
    assert report["ledger"]["sample_count"] == 3
    assert any(e["state"] == "Observation gap" for e in report["ledger"]["continuity"])
    assert recorder.detail("other", "cap") is None
    with db() as con:
        con.execute("DELETE FROM bench_samples WHERE elapsed_ms=4500")
    assert recorder.detail("uav", "cap")["ledger"]["status"] == "MISMATCH"
    with db() as con:
        con.execute("DELETE FROM bench_ledger")
    assert recorder.detail("uav", "cap")["ledger"]["status"] == "UNSEALED"


def test_backup_and_source_transitions_are_separate():
    live = dict(transport="USB", status="LIVE", heartbeat_fresh=True, attitude_fresh=True)
    stale = dict(live, status="STALE")
    rows = [dict(elapsed_ms=i * 1000, primary=p, backup=live, active_source=source)
            for i, (p, source) in enumerate([(live, "PRIMARY"), (stale, "PRIMARY"), (stale, "BACKUP")])]
    events = continuity(rows)
    assert [e["state"] for e in events] == ["Both receivers live", "Backup only", "Backup only"]
    assert events[-1]["detail"] == "Viewer: BACKUP"
