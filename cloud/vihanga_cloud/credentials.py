"""Aircraft-bound credentials for the versioned broker configuration."""
from __future__ import annotations

from hashlib import sha256
import hmac
import json
from pathlib import Path
import re
import time

ROLES = ("device", "viewer")


class CredentialFile:
    def __init__(self, filename: str):
        self.path = Path(filename)
        self.topology, self.credentials = self.read()
        self.next_check = time.monotonic() + 1

    def read(self):
        with self.path.open("rb") as source:
            raw = source.read(262145)
        if len(raw) > 262144:
            raise ValueError("Broker credential file is too large")
        data = json.loads(raw)
        if data["version"] != 2 or not isinstance(data["aircraft"], list) or not 1 <= len(data["aircraft"]) <= 100:
            raise ValueError("Expected version 2 broker credentials")
        topology, credentials, digests = {}, {}, set()
        for aircraft in data["aircraft"]:
            vehicle, sysid, org = aircraft["vehicle_id"], aircraft["system_id"], aircraft["organization"]
            if vehicle in topology or type(sysid) is not int or not isinstance(org, str):
                raise ValueError("Invalid aircraft topology")
            topology[vehicle] = (sysid, org)
            for role in ROLES:
                items = aircraft[role + "_credentials"]
                if not isinstance(items, list) or len(items) > 4:
                    raise ValueError("Invalid broker credential set")
                accepted = []
                for item in items:
                    digest, expires = item["sha256"], item["expires_at"]
                    if (not re.fullmatch(r"[a-f0-9]{64}", digest) or digest in digests
                            or type(expires) is not int or not 0 < expires <= 253402300799):
                        raise ValueError("Invalid or duplicate broker credential")
                    digests.add(digest)
                    accepted.append((digest, expires))
                credentials[vehicle, role] = tuple(accepted)
        return topology, credentials

    def authorize(self, vehicle: str, role: str, token: str) -> bool:
        now = time.monotonic()
        if now >= self.next_check:
            self.next_check = now + 1
            try:
                topology, credentials = self.read()
                self.credentials = credentials if topology == self.topology else {}
            except (ValueError, KeyError, TypeError, OSError):
                self.credentials = {}
        hashed = sha256(token.encode("utf-8")).hexdigest()
        wall = time.time()
        return any(hmac.compare_digest(hashed, digest) and wall < expires
                   for digest, expires in self.credentials.get((vehicle, role), ()))
