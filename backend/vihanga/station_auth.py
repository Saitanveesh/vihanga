"""Loopback operator sessions with explicit aircraft grants."""
from __future__ import annotations

import asyncio
from collections import deque
from contextvars import ContextVar
from dataclasses import dataclass
from getpass import getpass
from hashlib import scrypt, sha256
import hmac
import json
import os
from pathlib import Path
import re
from secrets import token_bytes, token_urlsafe
import time

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.responses import JSONResponse

COOKIE = "vihanga_station_session"
LOCAL_BROWSER_ORIGINS = {
    "http://127.0.0.1:5173", "http://localhost:5173",
    "http://127.0.0.1:8010", "http://localhost:8010",
}
USER_ID = re.compile(r"[a-zA-Z0-9_.-]{3,64}")
AIRCRAFT_ID = re.compile(r"[A-Z0-9][A-Z0-9_-]{2,31}")


@dataclass(frozen=True)
class Principal:
    username: str
    role: str
    aircraft: frozenset[str]

    def permits(self, vehicle_id: str) -> bool:
        return self.role == "admin" or vehicle_id in self.aircraft


principal: ContextVar[Principal | None] = ContextVar("station_principal", default=None)


def can_see(vehicle_id: str) -> bool:
    account = principal.get()
    return account is None or account.permits(vehicle_id)


def password_digest(password: str, salt: bytes) -> bytes:
    return scrypt(password.encode("utf-8"), salt=salt, n=32768, r=8, p=3, maxmem=64 * 1024 * 1024)


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(max_length=64)
    password: str = Field(max_length=256, min_length=1)


class StationAccess:
    def __init__(self):
        self.operators = {}
        self.sessions: dict[bytes, tuple[Principal, float]] = {}
        self.attempts: deque[float] = deque()
        self.hash_slots = asyncio.Semaphore(2)
        self.dummy = (token_bytes(16), token_bytes(64))
        config = os.environ.get("VIHANGA_STATION_OPERATORS_FILE")
        self.enabled = bool(config)
        if not config:
            return
        try:
            self.ttl = int(os.environ.get("VIHANGA_STATION_SESSION_SECONDS", "3600"))
            if not 60 <= self.ttl <= 43200:
                raise ValueError
            path = Path(config)
            with path.open("rb") as source:
                raw = source.read(65537)
            if len(raw) > 65536:
                raise ValueError
            data = json.loads(raw)
            if data["version"] != 1 or not isinstance(data["operators"], list) or not 1 <= len(data["operators"]) <= 100:
                raise ValueError
            for user in data["operators"]:
                name, role, aircraft = user["username"], user["role"], user["aircraft"]
                if (not USER_ID.fullmatch(name) or name in self.operators
                        or role not in ("admin", "operator", "viewer")
                        or not isinstance(aircraft, list) or len(aircraft) > 100
                        or not all(AIRCRAFT_ID.fullmatch(item) for item in aircraft)
                        or (role != "admin" and not aircraft)):
                    raise ValueError
                salt, hashed = bytes.fromhex(user["salt"]), bytes.fromhex(user["password_scrypt"])
                if len(salt) != 16 or len(hashed) != 64:
                    raise ValueError
                self.operators[name] = (Principal(name, role, frozenset(aircraft)), (salt, hashed))
            if not any(user.role == "admin" for user, _ in self.operators.values()):
                raise ValueError
        except (ValueError, TypeError, KeyError, OSError) as exc:
            raise RuntimeError("Invalid station operator configuration") from exc

    @staticmethod
    def key(token: str) -> bytes:
        return sha256(token.encode("utf-8")).digest()

    def identify(self, token: str) -> Principal | None:
        if not 32 <= len(token) <= 64:
            return None
        session = self.sessions.get(self.key(token))
        return session[0] if session and time.monotonic() < session[1] else None

    async def login(self, login: Login) -> str:
        now = time.monotonic()
        while self.attempts and now - self.attempts[0] >= 60:
            self.attempts.popleft()
        if len(self.attempts) >= 12:
            raise HTTPException(429, "Too many sign-in attempts. Try again in a minute.")
        self.attempts.append(now)
        account, (salt, expected) = self.operators.get(login.username, (None, self.dummy))
        async with self.hash_slots:
            candidate = await asyncio.to_thread(password_digest, login.password, salt)
        if not hmac.compare_digest(candidate, expected) or account is None:
            raise HTTPException(401, "Invalid station credentials")
        now = time.monotonic()
        self.sessions = {key: value for key, value in self.sessions.items() if now < value[1]}
        if len(self.sessions) >= 64:
            self.sessions.pop(next(iter(self.sessions)))
        token = token_urlsafe(32)
        self.sessions[self.key(token)] = (account, now + self.ttl)
        return token

    def install(self, app: FastAPI) -> None:
        @app.get("/api/v1/station/session")
        async def session(request: Request, response: Response):
            account = self.identify(request.cookies.get(COOKIE, ""))
            response.headers["Cache-Control"] = "no-store"
            return {"required": self.enabled, "username": account.username if account else None,
                    "role": account.role if account else None}

        @app.post("/api/v1/station/login")
        async def sign_in(payload: Login, request: Request, response: Response):
            if not self.enabled:
                raise HTTPException(404, "Station sign-in is disabled")
            token = await self.login(payload)
            self.sessions.pop(self.key(request.cookies.get(COOKIE, "")), None)
            response.set_cookie(COOKIE, token, max_age=self.ttl, httponly=True, samesite="strict",
                                secure=request.url.scheme == "https")
            response.headers["Cache-Control"] = "no-store"
            return {"required": True, "username": payload.username,
                    "role": self.operators[payload.username][0].role}

        @app.post("/api/v1/station/logout")
        async def sign_out(request: Request, response: Response):
            self.sessions.pop(self.key(request.cookies.get(COOKIE, "")), None)
            response.delete_cookie(COOKIE, httponly=True, samesite="strict",
                                   secure=request.url.scheme == "https")
            response.headers["Cache-Control"] = "no-store"
            return {"required": self.enabled, "username": None, "role": None}

        if not self.enabled:
            return

        @app.middleware("http")
        async def authorize(request: Request, call_next):
            path, method = request.url.path.rstrip("/"), request.method
            if not path.startswith("/api/"):
                return await call_next(request)
            if method not in ("GET", "HEAD", "OPTIONS"):
                origin = request.headers.get("origin")
                if ((origin is not None and origin not in LOCAL_BROWSER_ORIGINS)
                        or request.headers.get("sec-fetch-site") == "cross-site"):
                    return JSONResponse({"detail": "Browser origin not approved"}, status_code=403)
            if path in ("/api/v1/health", "/api/v1/station/session", "/api/v1/station/login", "/api/v1/station/logout"):
                return await call_next(request)
            account = self.identify(request.cookies.get(COOKIE, ""))
            if account is None:
                return JSONResponse({"detail": "Station sign-in required"}, status_code=401)
            if method not in ("GET", "HEAD", "OPTIONS") and account.role == "viewer":
                return JSONResponse({"detail": "Viewer access is read-only"}, status_code=403)
            if path == "/api/v1/vehicles" and method == "POST" and account.role != "admin":
                return JSONResponse({"detail": "Station administrator required"}, status_code=403)
            context = principal.set(account)
            try:
                response = await call_next(request)
                response.headers["Cache-Control"] = "no-store"
                return response
            finally:
                principal.reset(context)


if __name__ == "__main__":
    password = getpass("Station password: ")
    if not 12 <= len(password) <= 256 or password != getpass("Repeat password: "):
        raise SystemExit("Use a matching password of 12 to 256 characters.")
    salt = token_bytes(16)
    print(json.dumps({"salt": salt.hex(), "password_scrypt": password_digest(password, salt).hex()}))
