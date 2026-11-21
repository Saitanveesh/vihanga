from math import cos, pi, sin

from fastapi.testclient import TestClient
from vihanga.app import create_app


def square():
    return [
        {"latitude": 12.9700, "longitude": 77.5900},
        {"latitude": 12.9700, "longitude": 77.5910},
        {"latitude": 12.9710, "longitude": 77.5910},
        {"latitude": 12.9710, "longitude": 77.5900},
    ]


def test_bounded_parallel_survey_estimated_duration(tmp_path):
    c = TestClient(create_app(tmp_path / "one.sqlite3"))
    payload = dict(polygon=square(), spacing_m=20, angle_deg=0, altitude_m=40, speed_mps=5)
    r = c.post("/api/v1/surveys/preview", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "PREVIEW_ONLY"
    assert d["lane_count"] >= 3
    assert d["estimated_duration_s"] == round(d["route_distance_m"] / 5, 1)
    assert d["requires_route_review"]
    for point in d["waypoints"]:
        assert 12.97-1e-6 <= point["latitude"] <= 12.971+1e-6
        assert 77.59-1e-6 <= point["longitude"] <= 77.591+1e-6


def test_circular_preview_and_area_constraints(tmp_path):
    c = TestClient(create_app(tmp_path / "two.sqlite3"))
    payload = dict(polygon=square(), spacing_m=20, altitude_m=40, speed_mps=4)
    r = c.post("/api/v1/surveys/circular/preview", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "PREVIEW_ONLY"
    assert d["pattern"] == "CIRCULAR"
    assert d["lane_count"] >= 2
    assert len(d["waypoints"]) == 25*d["lane_count"]
    assert d["estimated_duration_s"] == round(d["route_distance_m"]/4, 1)
    assert "corners are not covered" in d["coverage_note"]
    for point in d["waypoints"]:
        assert 12.97 <= point["latitude"] <= 12.971
        assert 77.59 <= point["longitude"] <= 77.591


def test_circular_refuses_nonconvex_and_invalid_speed(tmp_path):
    c = TestClient(create_app(tmp_path / "three.sqlite3"))
    concave = [
        {"latitude": 12.97, "longitude": 77.59},
        {"latitude": 12.97, "longitude": 77.591},
        {"latitude": 12.9704, "longitude": 77.5905},
        {"latitude": 12.971, "longitude": 77.591},
        {"latitude": 12.971, "longitude": 77.59},
    ]
    assert c.post("/api/v1/surveys/circular/preview", json={
        "polygon":concave,"spacing_m":20,"altitude_m":40
    }).status_code == 422
    assert c.post("/api/v1/surveys/preview", json={
        "polygon":square(),"spacing_m":20,"angle_deg":0,"altitude_m":40,"speed_mps":0
    }).status_code == 422


def test_persistence_only_draft_no_upload(tmp_path):
    c = TestClient(create_app(tmp_path / "four.sqlite3"))
    c.post("/api/v1/vehicles", json={
        "vehicle_id":"TEST-001","label":"Survey UAV","autopilot":"ARDUPILOT","interface":"UART"
    })
    points = c.post("/api/v1/surveys/preview", json={
        "polygon":square(),"spacing_m":20,"angle_deg":0,"altitude_m":40
    }).json()["waypoints"]
    r = c.post("/api/v1/missions", json={
        "vehicle_id":"TEST-001","title":"Offline pattern","waypoints":points
    })
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "DRAFT_ONLY"
    assert c.post("/api/v1/missions/" + r.json()["mission_id"] + "/upload").status_code == 404


def test_circular_rejects_crossed_vertex_order_and_contains_rotated_loops(tmp_path):
    client = TestClient(create_app(tmp_path / "circle.sqlite3"))
    shape = [
        {"latitude": 12.97 + .001 * sin(2 * pi * i / 5),
         "longitude": 77.59 + .001 * cos(2 * pi * i / 5)}
        for i in range(5)
    ]
    endpoint = "/api/v1/surveys/circular/preview"
    settings = {"spacing_m": 20, "altitude_m": 40}
    star = [shape[i] for i in (0, 2, 4, 1, 3)]
    assert client.post(endpoint, json={"polygon": star, **settings}).status_code == 422

    boundary = list(reversed(shape))
    response = client.post(endpoint, json={"polygon": [*boundary, boundary[0]], **settings})
    assert response.status_code == 200, response.text
    points = response.json()["waypoints"]
    # Check the rendered points and each straight segment midpoint, including ring transfers.
    midpoints = [{key: (a[key] + b[key]) / 2 for key in ("latitude", "longitude")}
                 for a, b in zip(points, points[1:])]
    for a, b in zip(boundary, boundary[1:] + boundary[:1]):
        for p in points + midpoints:
            cross = ((b["longitude"] - a["longitude"]) * (p["latitude"] - a["latitude"])
                     - (b["latitude"] - a["latitude"]) * (p["longitude"] - a["longitude"]))
            assert cross < 0
