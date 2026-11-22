from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from vihanga.app import create_app


def test_station_serves_build_and_preserves_api_routes(tmp_path: Path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>Vihanga station</html>", encoding="utf-8")
    (dist / "assets" / "index-abc123.js").write_text("console.log('station');", encoding="utf-8")
    (dist / "vihanga-mark.svg").write_text("<svg/>", encoding="utf-8")
    (dist / "private.txt").write_text("not public", encoding="utf-8")

    with TestClient(create_app(tmp_path / "gcs.sqlite3", console_dist=dist)) as client:
        index = client.get("/")
        assert index.status_code == 200 and "Vihanga station" in index.text
        assert index.headers["cache-control"] == "no-store"
        assert index.headers["x-vihanga-console"] == "production"
        assert client.get("/assets/index-abc123.js").status_code == 200
        assert client.get("/vihanga-mark.svg").status_code == 200
        assert client.get("/assets/missing.js").status_code == 404
        assert client.get("/private.txt").status_code == 404
        assert client.get("/api/v1/unknown").status_code == 404
        assert client.get("/api/v1/vehicles").json() == []
        health = client.get("/api/v1/health").json()
        assert health["deployment"] == "LOCAL_STATION"
        assert health["console_served"] is True
        assert health["physical_flight_control"] is False
        assert client.get("/", headers={"Host": "outside.example"}).status_code == 400


def test_static_console_compresses_and_caches_only_versioned_assets(tmp_path: Path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    text = "console.log('station');\n" * 100
    (dist / "index.html").write_text(text, encoding="utf-8")
    (dist / "assets" / "index-a1B2_cD3.js").write_text(text, encoding="utf-8")
    (dist / "assets" / "plain.js").write_text(text, encoding="utf-8")

    with TestClient(create_app(tmp_path / "gcs.sqlite3", console_dist=dist)) as client:
        headers = {"Accept-Encoding": "gzip"}
        path = "/assets/index-a1B2_cD3.js"
        asset = client.get(path, headers=headers)
        assert asset.status_code == 200 and asset.text == text
        assert asset.headers["content-encoding"] == "gzip"
        assert "Accept-Encoding" in asset.headers["vary"]
        assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
        identity = client.get(path, headers={"Accept-Encoding": "identity"})
        assert "content-encoding" not in identity.headers and identity.text == text
        assert "cache-control" not in client.get("/assets/plain.js").headers
        index = client.get("/", headers=headers)
        assert index.headers["cache-control"] == "no-store"
        assert "content-encoding" not in index.headers


def test_explicit_bundle_requires_built_assets(tmp_path: Path):
    with pytest.raises(RuntimeError, match="console bundle is missing"):
        create_app(tmp_path / "gcs.sqlite3", console_dist=tmp_path / "empty")
