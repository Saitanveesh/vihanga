"""Operator HTTP security boundary for the local Vihanga operations API.

All existing endpoints require login when VIHANGA_OPERATOR_AUTH=required.
Aircraft scopes are checked for both REST and live telemetry WebSockets.
Legacy mode preserves the existing localhost development setup.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.base import BaseHTTPMiddleware

from vihanga.operator_auth import (
    AccessDenied, OperatorStore, Principal, SESSION_SECONDS,
)

COOKIE = "vihanga_operator"
CSRF_COOKIE = "vihanga_csrf"
CSRF_HEADER = "x-vihanga-csrf"


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=1, max_length=256)


def mode_enabled() -> bool:
    import os
    return os.environ.get("VIHANGA_OPERATOR_AUTH", "legacy").lower() == "required"


def operator_token(request: Request) -> str | None:
    bearer = request.headers.get("authorization", "")
    if bearer.startswith("Bearer "):
        return bearer[7:]
    return request.cookies.get(COOKIE)


def websocket_token(websocket: WebSocket) -> str | None:
    bearer = websocket.headers.get("authorization", "")
    return bearer[7:] if bearer.startswith("Bearer ") else websocket.cookies.get(COOKIE)


def require_websocket(store: OperatorStore, websocket: WebSocket, vehicle_id: str) -> bool:
    if not mode_enabled():
        return True
    try:
        principal = store.authorize(websocket_token(websocket))
        store.require_scope(principal, vehicle_id)
        return True
    except AccessDenied:
        return False


def permitted_vehicle(principal: Principal | None, vehicle_id: str) -> bool:
    return principal is None or principal.allowed(vehicle_id)


def visible(principal: Principal | None, vehicle_id: str) -> bool:
    return permitted_vehicle(principal, vehicle_id)


def install_operator_security(app: FastAPI, db_path: str | Path) -> OperatorStore:
    store = OperatorStore(db_path)
    app.state.operator_store = store

    @app.middleware("http")
    async def enforce_operator_session(request: Request, call_next):
        path = request.url.path
        if not mode_enabled() or not path.startswith("/api/v1/") or path in {
            "/api/v1/health", "/api/v1/capabilities",
            "/api/v1/auth/status", "/api/v1/auth/login"
        }:
            return await call_next(request)

        try:
            principal = store.authorize(
                operator_token(request),
                mutation=request.method not in ("GET", "HEAD", "OPTIONS"),
                csrf=request.headers.get(CSRF_HEADER)
            )
            request.state.operator = principal
            is_write = request.method not in ("GET", "HEAD", "OPTIONS")
            if is_write and not principal.can_write():
                raise AccessDenied("Pilot or administrator role required")
            if path == "/api/v1/vehicles" and is_write and principal.role != "ADMIN":
                raise AccessDenied("Administrator role required")
            if path == "/api/v1/auth/audit" and principal.role != "ADMIN":
                raise AccessDenied("Administrator role required")

            # Scope gate, before endpoint handlers can read vehicle data.
            bits = path.strip("/").split("/")
            vehicle_id = None
            if len(bits) >= 4:
                if bits[2] in ("telemetry", "flight-tracks", "operator"):
                    vehicle_id = bits[3]
                elif bits[2] == "links":
                    if bits[3] == "select" and len(bits) >= 5:
                        vehicle_id = bits[4]
                    elif bits[3] == "backup" and len(bits) == 5 and request.method == "DELETE":
                        vehicle_id = bits[4]
                    elif len(bits) == 4 and request.method == "DELETE":
                        vehicle_id = bits[3]
                # Mission IDs resolve to an aircraft inside the endpoint.
            if is_write and (path.startswith("/api/v1/links/") or
                             path == "/api/v1/missions"):
                # Starlette caches the body for downstream FastAPI parsing.
                # Refuse unknown or absent aircraft IDs rather than treating
                # them as global scope.
                if vehicle_id is None:
                    data = await request.json()
                    if not isinstance(data, dict):
                        raise AccessDenied("Aircraft identifier required")
                    vehicle_id = data.get("vehicle_id")
            if vehicle_id:
                store.require_scope(principal, vehicle_id, write=is_write)
        except AccessDenied as error:
            return JSONResponse(status_code=error.http_status,
                                content={"detail": str(error)})
        except (ValueError, TypeError):
            return JSONResponse(status_code=400,
                                content={"detail": "Malformed scoped request"})
        return await call_next(request)

    @app.get("/api/v1/auth/status")
    def auth_status():
        return {"mode": "REQUIRED" if mode_enabled() else "LEGACY",
                "provisioned": store.count_accounts() > 0,
                "flight_control_enabled": False}

    @app.post("/api/v1/auth/login")
    def auth_login(payload: LoginInput, response: Response):
        if not mode_enabled():
            raise HTTPException(status_code=409, detail="Operator login mode is disabled")
        if not store.count_accounts():
            raise HTTPException(status_code=503, detail="Provision an operator account locally")
        try:
            token, csrf, principal = store.login(payload.username, payload.password)
        except AccessDenied as error:
            raise HTTPException(status_code=error.http_status, detail=str(error)) from error
        response.set_cookie(
            COOKIE, token, max_age=SESSION_SECONDS, httponly=True,
            samesite="strict", secure=False, path="/"
        )
        response.set_cookie(
            CSRF_COOKIE, csrf, max_age=SESSION_SECONDS, httponly=False,
            samesite="strict", secure=False, path="/"
        )
        return {"username": principal.username, "role": principal.role,
                "aircraft": principal.aircraft, "expires_at": principal.expiry,
                "csrf_token": csrf, "flight_control_enabled": False}

    @app.get("/api/v1/auth/me")
    def auth_me(request: Request):
        if not mode_enabled():
            return {"mode": "LEGACY", "authenticated": False}
        try:
            principal = store.authorize(operator_token(request))
        except AccessDenied as error:
            raise HTTPException(status_code=error.http_status, detail=str(error)) from error
        csrf = request.cookies.get(CSRF_COOKIE)
        if not csrf or store._hash(csrf) != principal.csrf_hash:
            csrf = None
        return {"mode": "REQUIRED", "authenticated": True,
                "username": principal.username, "role": principal.role,
                "aircraft": principal.aircraft, "expires_at": principal.expiry,
                "csrf_token": csrf, "flight_control_enabled": False}

    @app.post("/api/v1/auth/logout")
    def auth_logout(request: Request, response: Response):
        principal = request.state.operator
        store.revoke(principal)
        response.delete_cookie(COOKIE, path="/")
        response.delete_cookie(CSRF_COOKIE, path="/")
        return {"logged_out": True}

    @app.get("/api/v1/auth/audit")
    def auth_audit(request: Request):
        if not mode_enabled():
            raise HTTPException(status_code=403, detail="Audit requires enforced authentication")
        if request.state.operator.role != "ADMIN":
            raise HTTPException(status_code=403, detail="Administrator role required")
        return {"events": store.audit_recent(), "max_events": 200}

    return store
