"""Synthetic-only identities for tests. These are not production credentials."""
import hashlib
import json
import os


def h(value):
    return hashlib.sha256(value.encode()).hexdigest()


os.environ["VIHANGA_CLOUD_AIRCRAFT_JSON"] = json.dumps([
    {"vehicle_id": "TEST-001", "system_id": 1, "organization": "lab-a",
     "device_token_sha256": h("D" * 40), "viewer_token_sha256": h("V" * 40)},
    {"vehicle_id": "TEST-002", "system_id": 2, "organization": "lab-b",
     "device_token_sha256": h("E" * 40), "viewer_token_sha256": h("W" * 40)}
])
