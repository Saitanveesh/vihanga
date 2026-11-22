import time

import pytest
from pydantic import ValidationError

from vihanga.link_evidence import UpstreamEvidence


def record():
    return {"version": 1, "vehicle_id": "AIR-001", "edge_report_age_ms": 100,
            "relay": {"online": True, "epoch": 2, "received": 10, "rejected": 0,
                      "viewer_dropped": 2, "packet_age_ms": 100},
            "edge": {"version": 1, "uart_open": True, "uart_bytes": 250, "uart_accepted": 12,
                     "uart_rejected": 1, "uart_age_ms": 100, "uplink_sent": 11, "uplink_dropped": 1}}


def test_path_localizes_observations_and_expires_evidence():
    data = record()
    now = time.monotonic()
    evidence = UpstreamEvidence.model_validate(data)
    assert evidence.snapshot(now, 80)["diagnosis"] == "THREE_LEGS_OBSERVED"
    assert evidence.snapshot(now, None)["diagnosis"] == "RELAY_TO_STATION_STALE"
    assert evidence.snapshot(now - 7, 80) is None
    data["relay"]["packet_age_ms"] = 4000
    assert UpstreamEvidence.model_validate(data).snapshot(now, None)["diagnosis"] == "EDGE_TO_RELAY_STALE"
    data["edge"]["uart_age_ms"] = None
    assert UpstreamEvidence.model_validate(data).snapshot(now, None)["diagnosis"] == "UART_WAITING"
    data["relay"]["online"] = False
    assert UpstreamEvidence.model_validate(data).snapshot(now, None)["diagnosis"] == "EDGE_UPLINK_OFFLINE"
    data["edge"]["viewer_token"] = "unexpected field"
    with pytest.raises(ValidationError):
        UpstreamEvidence.model_validate(data)
