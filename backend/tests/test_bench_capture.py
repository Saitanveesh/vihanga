import sqlite3
import time
from io import BytesIO

from fastapi.testclient import TestClient
from pymavlink.dialects.v20 import ardupilotmega as mavlink

from vihanga import bench
from vihanga.app import create_app
from vihanga.telemetry import MAVLinkProjector, Session


def register(client, vehicle_id):
    response = client.post("/api/v1/vehicles", json={
        "vehicle_id": vehicle_id, "label": "Bench aircraft",
        "autopilot": "ARDUPILOT", "interface": "UART",
    })
    assert response.status_code == 201
    return "/api/v1/bench/captures/" + vehicle_id


def await_capture(client, path, predicate):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        report = client.get(path).json()
        if predicate(report):
            return report
        time.sleep(0.015)
    raise AssertionError(f"Capture did not reach expected condition: {report['capture']}")


def test_incoming_fc_evidence_persists_and_offline_has_no_fake_age(tmp_path, monkeypatch):
    monkeypatch.setattr(bench, "SAMPLE_SECONDS", 0.04)
    database = tmp_path / "station.sqlite"
    app = create_app(database)
    links = app.state.links
    with TestClient(app) as client:
        path = register(client, "BENCH-001")
        other = register(client, "BENCH-002")
        projector = MAVLinkProjector(7)
        links.sessions["BENCH-001"] = Session("BENCH-001", "LOCAL_SERIAL_RECEIVE", projector, state="CONNECTED")
        started = client.post(path, json={"duration_seconds": 60}).json()
        capture_path = path + "/" + started["capture_id"]
        assert client.post(other, json={"duration_seconds": 60}).status_code == 409
        assert client.post(other + "/" + started["capture_id"] + "/stop").status_code == 404
        initial = client.get(capture_path).json()["samples"][0]
        assert initial["primary"]["age_ms"] is None
        assert initial["primary"]["system_id"] == 7
        assert initial["primary"]["status"] == "WAITING_FOR_FRAMES"
        assert initial["backup"]["status"] == "NOT_CONFIGURED"

        wire = mavlink.MAVLink(BytesIO(), srcSystem=7, srcComponent=1)
        projector.push(mavlink.MAVLink_heartbeat_message(2, 3, 0, 0, 3, 3).pack(wire))
        projector.push(mavlink.MAVLink_attitude_message(100, .1, -.2, .3, 0, 0, 0).pack(wire))
        await_capture(client, capture_path, lambda r: r["summary"]["primary"]["live_samples"] > 0)
        client.delete("/api/v1/links/BENCH-001").raise_for_status()
        await_capture(client, capture_path, lambda r: r["samples"][-1]["primary"]["status"] == "OFFLINE")
        report = client.post(capture_path + "/stop").json()
        assert report["capture"]["status"] == "STOPPED"
        assert report["summary"]["primary"]["p95_ms"] is not None
        assert report["summary"]["backup"]["p95_ms"] is None
        assert [event["to"] for event in report["summary"]["events"]] == ["LIVE", "OFFLINE"]
        assert report["samples"][-1]["primary"]["age_ms"] is None
        assert client.post(capture_path + "/stop").json() == report

    with TestClient(create_app(database)) as restarted:
        assert restarted.get(capture_path).json() == report
        assert restarted.get(other).json() == []


def test_completion_origin_checks_and_rotation(tmp_path, monkeypatch):
    monkeypatch.setattr(bench, "SAMPLE_SECONDS", .012)
    monkeypatch.setattr(bench, "RETAINED_CAPTURES", 2)
    with TestClient(create_app(tmp_path / "station.sqlite")) as client:
        path = register(client, "BENCH-001")
        request = {"duration_seconds": 30}
        assert client.post(path, json=request, headers={"Origin": "https://outside.example"}).status_code == 403
        assert client.post(path, json=request, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
        assert client.post(path, json={"duration_seconds": 600}).status_code == 422
        first = client.post(path, json=request, headers={"Origin": "http://127.0.0.1:8010"}).json()
        first_path = path + "/" + first["capture_id"]
        finished = await_capture(client, first_path, lambda r: r["capture"]["status"] == "COMPLETE")
        assert 1 < finished["summary"]["sample_count"] <= 30
        assert finished["summary"]["primary"]["live_samples"] == 0
        second = client.post(path, json=request).json()
        assert client.post(path + "/" + second["capture_id"] + "/stop").status_code == 200
        third = client.post(path, json=request).json()
        assert client.post(path + "/" + third["capture_id"] + "/stop").status_code == 200
        assert [item["capture_id"] for item in client.get(path).json()] == [third["capture_id"], second["capture_id"]]
        assert client.get(first_path).status_code == 404


def test_recovers_interrupted_capture_on_restart(tmp_path):
    database = tmp_path / "station.sqlite"
    with TestClient(create_app(database)) as client:
        path = register(client, "BENCH-001")
        started = client.post(path, json={"duration_seconds": 30}).json()
        capture_path = path + "/" + started["capture_id"]
    # Recreate the row left on disk by an abrupt termination before finalization.
    with sqlite3.connect(database) as con:
        con.execute("UPDATE bench_captures SET status = 'RECORDING', ended_at = NULL")
    with TestClient(create_app(database)) as restarted:
        report = restarted.get(capture_path).json()
        assert report["capture"]["status"] == "INTERRUPTED"
        assert report["capture"]["ended_at"] == report["samples"][-1]["captured_at"]
        assert restarted.post(path, json={"duration_seconds": 30}).status_code == 201


def test_summary_does_not_mix_roles_or_count_stale_ages():
    def receiver(status, age, transport):
        return {"status": status, "age_ms": age, "transport": transport,
                "heartbeat_fresh": status == "LIVE", "attitude_fresh": status == "LIVE"}

    primary = [receiver("LIVE", age, "CLOUD") for age in (10, 20, 400)]
    primary.append(receiver("STALE", 3000, "CLOUD"))
    data = [{"elapsed_ms": index * 1000, "primary": reading,
             "backup": receiver("LIVE", 1000, "SERIAL"),
             "active_source": "PRIMARY" if index < 3 else "BACKUP"}
            for index, reading in enumerate(primary)]
    report = bench.summarize(data)
    assert report["primary"]["p50_ms"] == 20
    assert report["primary"]["p95_ms"] == report["primary"]["p99_ms"] == 400
    assert report["backup"]["p95_ms"] == 1000
    assert [(event["field"], event["to"]) for event in report["events"]] == [
        ("primary", "STALE"), ("active_source", "BACKUP")]
