from fastapi.testclient import TestClient
from vihanga.app import create_app


def square():
    return [
        {"latitude": 12.9700, "longitude": 77.5900},
        {"latitude": 12.9700, "longitude": 77.5910},
        {"latitude": 12.9710, "longitude": 77.5910},
        {"latitude": 12.9710, "longitude": 77.5900},
    ]


def test_valid_survey_is_real_geometry_and_preview_only(tmp_path):
    c = TestClient(create_app(tmp_path / "survey.sqlite3"))
    response = c.post("/api/v1/surveys/preview", json={
        "polygon": square(), "spacing_m": 20, "angle_deg": 0, "altitude_m": 40
    })
    assert response.status_code == 200, response.text
    d = response.json()
    assert d["status"] == "PREVIEW_ONLY"
    assert d["requires_route_review"]
    assert d["lane_count"] >= 3
    assert len(d["waypoints"]) == d["lane_count"] * 2
    assert d["route_distance_m"] > 100
    assert 10000 < d["area_m2"] < 20000
    for p in d["waypoints"]:
        assert 12.97 - 1e-6 <= p["latitude"] <= 12.971 + 1e-6
        assert 77.59 - 1e-6 <= p["longitude"] <= 77.591 + 1e-6
        assert p["altitude_m"] == 40


def test_invalid_survey_is_rejected(tmp_path):
    c = TestClient(create_app(tmp_path / "survey.sqlite3"))
    crossed = [square()[0], square()[2], square()[1], square()[3]]
    assert c.post("/api/v1/surveys/preview", json={
        "polygon": crossed, "spacing_m": 20, "angle_deg": 0, "altitude_m": 40
    }).status_code == 422
    assert c.post("/api/v1/surveys/preview", json={
        "polygon": square(), "spacing_m": 0, "angle_deg": 0, "altitude_m": 40
    }).status_code == 422
    assert c.post("/api/v1/surveys/preview", json={
        "polygon": square(), "spacing_m": 20, "angle_deg": 0, "altitude_m": 200
    }).status_code == 422
