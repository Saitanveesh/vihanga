"""Validate and classify independently measured telemetry legs."""
from __future__ import annotations

import asyncio
import time
from typing import Annotated, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictBool

Count = Annotated[int, Field(strict=True, ge=0, le=2**53 - 1)]
LIVE_MS = 3000
EVIDENCE_MS = 6000


class RelayEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    online: StrictBool
    epoch: Count
    received: Count
    rejected: Count
    viewer_dropped: Count
    packet_age_ms: Count | None


class EdgeEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    uart_open: StrictBool
    uart_bytes: Count
    uart_accepted: Count
    uart_rejected: Count
    uart_age_ms: Count | None
    uplink_sent: Count
    uplink_dropped: Count


class UpstreamEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    vehicle_id: str
    relay: RelayEvidence
    edge_report_age_ms: Count | None
    edge: EdgeEvidence | None

    def snapshot(self, captured_at: float, station_age: int | None) -> dict | None:
        elapsed = round((time.monotonic() - captured_at) * 1000)
        if elapsed > EVIDENCE_MS:
            return None
        data = self.model_dump(exclude={"vehicle_id"})
        relay, edge = data["relay"], data["edge"]
        if relay["packet_age_ms"] is not None:
            relay["packet_age_ms"] += elapsed
        report_age = data["edge_report_age_ms"]
        if report_age is not None:
            data["edge_report_age_ms"] = report_age + elapsed
        if report_age is None or report_age + elapsed > EVIDENCE_MS:
            data["edge"] = edge = None
        if edge and edge["uart_age_ms"] is not None:
            edge["uart_age_ms"] += report_age + elapsed

        def recent(age):
            return age is not None and age <= LIVE_MS

        if not relay["online"]:
            reason = "EDGE_UPLINK_OFFLINE"
        elif edge and (not edge["uart_open"] or not recent(edge["uart_age_ms"])):
            reason = "UART_WAITING"
        elif edge and not recent(relay["packet_age_ms"]):
            reason = "EDGE_TO_RELAY_STALE"
        elif recent(relay["packet_age_ms"]) and not recent(station_age):
            reason = "RELAY_TO_STATION_STALE"
        elif edge and recent(station_age):
            reason = "THREE_LEGS_OBSERVED"
        else:
            reason = "UPSTREAM_EVIDENCE_PARTIAL"
        return {**data, "diagnosis": reason}


async def poll_upstream(session, origin: str, token: str):
    path = origin + "/api/v1/diagnostics/" + session.vehicle_id
    async with httpx.AsyncClient(timeout=2.5, follow_redirects=False) as client:
        while True:
            try:
                async with asyncio.timeout(3):
                    async with client.stream("GET", path, headers={"Authorization": "Bearer " + token}) as response:
                        response.raise_for_status()
                        content = bytearray()
                        async for chunk in response.aiter_bytes(chunk_size=1024):
                            content.extend(chunk)
                            if len(content) > 4096:
                                raise ValueError("Diagnostic payload exceeds limit")
                evidence = UpstreamEvidence.model_validate_json(content)
                if evidence.vehicle_id != session.vehicle_id:
                    raise ValueError("Aircraft diagnosis differs from receiver aircraft")
                session.upstream = (evidence, time.monotonic())
            except (httpx.HTTPError, TimeoutError, ValueError):
                session.upstream = None
            await asyncio.sleep(2)
