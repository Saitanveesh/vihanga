"""Local human-operator identity and aircraft-scoped session store.

This is NOT a MAVLink command authority. Devices and cloud viewer tokens
remain separate and cannot be exchanged for human operator privileges.

Local development stays compatible in LEGACY mode; use
VIHANGA_OPERATOR_AUTH=required with a provisioned account for enforcement.
"""
from __future__ import annotations

from dataclasses import dataclass
from getpass import getpass
from hashlib import scrypt, sha256
import argparse
import hmac
import json
from pathlib import Path
import re
import secrets
import sqlite3
import time
from typing import Callable


SCOPED_ROLES = frozenset(("PILOT", "VIEWER"))
ROLES = frozenset(("ADMIN", "PILOT", "VIEWER"))
SESSION_SECONDS = 30 * 60
MAX_LOGIN_FAILURES = 5
LOCK_SECONDS = 5 * 60
USERNAME_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{2,31}$")
VEHICLE_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9_-]{2,31}$")


class AccessDenied(Exception):
    def __init__(self, message: str, http_status: int = 403):
        super().__init__(message)
        self.http_status = http_status


@dataclass(frozen=True)
class Principal:
    username: str
    role: str
    aircraft: tuple[str, ...]
    expiry: int
    csrf_hash: str
    session_hash: str

    def allowed(self, vehicle_id: str) -> bool:
        return self.role == "ADMIN" or vehicle_id in self.aircraft

    def can_write(self) -> bool:
        return self.role in ("PILOT", "ADMIN")


class OperatorStore:
    def __init__(self, path: str | Path, clock: Callable[[], float] = time.time):
        self.path = Path(path)
        self.clock = clock
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as con:
            con.executescript("""
            CREATE TABLE IF NOT EXISTS operator_accounts(
                username TEXT PRIMARY KEY, role TEXT NOT NULL,
                aircraft_json TEXT NOT NULL, salt_hex TEXT NOT NULL,
                password_hex TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS operator_sessions(
                token_hash TEXT PRIMARY KEY, username TEXT NOT NULL
                    REFERENCES operator_accounts(username),
                csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL, revoked_at INTEGER,
                FOREIGN KEY(username) REFERENCES operator_accounts(username));
            CREATE TABLE IF NOT EXISTS operator_login_limits(
                username TEXT PRIMARY KEY, failures INTEGER NOT NULL,
                locked_until INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS operator_audit(
                id INTEGER PRIMARY KEY AUTOINCREMENT, when_utc INTEGER NOT NULL,
                actor TEXT NOT NULL, action TEXT NOT NULL, aircraft TEXT,
                result TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_operator_sessions_expiry
                ON operator_sessions(expires_at);
            """)

    def _db(self):
        con = sqlite3.connect(self.path, timeout=5)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        return con

    @staticmethod
    def _digest(password: str, salt: bytes) -> str:
        return scrypt(password.encode("utf-8"), salt=salt,
                      n=2**14, r=8, p=1, dklen=32).hex()

    @staticmethod
    def _hash(token: str) -> str:
        return sha256(token.encode("utf-8")).hexdigest()

    def _audit(self, con, actor: str, action: str,
               result: str, aircraft: str | None = None):
        con.execute(
            "INSERT INTO operator_audit(when_utc,actor,action,aircraft,result) VALUES(?,?,?,?,?)",
            (int(self.clock()), actor, action, aircraft, result)
        )

    def provision(self, username: str, password: str, role: str,
                  aircraft: list[str] | tuple[str, ...] = ()) -> None:
        if not USERNAME_PATTERN.fullmatch(username):
            raise ValueError("Username must be lowercase and 3-32 safe characters")
        if not 14 <= len(password) <= 256 or password.isspace():
            raise ValueError("A password of 14-256 characters is required")
        if role not in ROLES:
            raise ValueError("Unknown operator role")
        scopes = tuple(sorted(set(aircraft)))
        if any(not VEHICLE_PATTERN.fullmatch(v) for v in scopes):
            raise ValueError("Invalid aircraft scope identifier")
        if role in SCOPED_ROLES and not scopes:
            raise ValueError("Pilot/viewer accounts require aircraft scopes")
        if role == "ADMIN" and scopes:
            raise ValueError("ADMIN uses global scope and cannot have explicit aircraft")
        salt = secrets.token_bytes(16)
        digest = self._digest(password, salt)
        with self._db() as con:
            existing = con.execute(
                "SELECT username FROM operator_accounts WHERE username=?", (username,)
            ).fetchone()
            if existing:
                raise ValueError("Operator account already exists")
            con.execute(
                "INSERT INTO operator_accounts(username,role,aircraft_json,salt_hex,password_hex) "
                "VALUES(?,?,?,?,?)",
                (username, role, json.dumps(scopes), salt.hex(), digest)
            )
            self._audit(con, username, "ACCOUNT_PROVISION", "SUCCESS")
            con.commit()

    def count_accounts(self) -> int:
        with self._db() as con:
            return con.execute("SELECT count(*) FROM operator_accounts").fetchone()[0]

    def login(self, username: str, password: str) -> tuple[str, str, Principal]:
        # Serialize attempts across workers with a SQLite write transaction.
        now = int(self.clock())
        with self._db() as con:
            con.execute("BEGIN IMMEDIATE")
            state = con.execute(
                "SELECT failures,locked_until FROM operator_login_limits WHERE username=?",
                (username,)
            ).fetchone()
            if state and int(state["locked_until"]) > now:
                self._audit(con, username, "LOGIN", "DENIED_THROTTLED")
                con.commit()
                raise AccessDenied("Invalid credentials or login temporarily blocked", 401)
            account = con.execute(
                "SELECT * FROM operator_accounts WHERE username=?", (username,)
            ).fetchone()
            dummy_salt = bytes.fromhex("0112233445566778899aabbccddeeff0")
            digest = self._digest(password, bytes.fromhex(account["salt_hex"])
                                  if account else dummy_salt)
            accepted = bool(account and account["enabled"] and
                            hmac.compare_digest(digest, account["password_hex"]))
            if not accepted:
                count = int(state["failures"]) + 1 if state else 1
                expiry = now + LOCK_SECONDS if count >= MAX_LOGIN_FAILURES else 0
                con.execute(
                    "INSERT INTO operator_login_limits(username,failures,locked_until) VALUES(?,?,?) "
                    "ON CONFLICT(username) DO UPDATE SET failures=excluded.failures,"
                    "locked_until=excluded.locked_until", (username, count, expiry)
                )
                self._audit(con, username, "LOGIN", "DENIED")
                con.commit()
                raise AccessDenied("Invalid credentials or login temporarily blocked", 401)
            con.execute("DELETE FROM operator_login_limits WHERE username=?", (username,))
            session_token = secrets.token_urlsafe(48)
            csrf = secrets.token_urlsafe(32)
            expiry = now + SESSION_SECONDS
            con.execute("DELETE FROM operator_sessions WHERE expires_at <= ?", (now,))
            con.execute(
                "INSERT INTO operator_sessions(token_hash,username,csrf_hash,created_at,expires_at) "
                "VALUES(?,?,?,?,?)",
                (self._hash(session_token), username, self._hash(csrf), now, expiry)
            )
            self._audit(con, username, "LOGIN", "SUCCESS")
            con.commit()
            principal = Principal(
                username, account["role"], tuple(json.loads(account["aircraft_json"])),
                expiry, self._hash(csrf), self._hash(session_token)
            )
            return session_token, csrf, principal

    def authorize(self, token: str | None, *, mutation: bool = False,
                  csrf: str | None = None) -> Principal:
        if not token or len(token) > 512:
            raise AccessDenied("Operator login required", 401)
        now = int(self.clock())
        with self._db() as con:
            row = con.execute(
                "SELECT s.*,a.role,a.aircraft_json,a.enabled FROM operator_sessions s "
                "JOIN operator_accounts a ON a.username=s.username WHERE s.token_hash=?",
                (self._hash(token),)
            ).fetchone()
        if not row or not row["enabled"] or row["revoked_at"] is not None or row["expires_at"] <= now:
            raise AccessDenied("Operator session expired or revoked", 401)
        if mutation and (not csrf or not hmac.compare_digest(self._hash(csrf), row["csrf_hash"])):
            raise AccessDenied("Valid CSRF token required")
        return Principal(row["username"], row["role"],
                         tuple(json.loads(row["aircraft_json"])),
                         row["expires_at"], row["csrf_hash"], row["token_hash"])

    def revoke(self, principal: Principal) -> None:
        with self._db() as con:
            con.execute(
                "UPDATE operator_sessions SET revoked_at=? WHERE token_hash=?",
                (int(self.clock()), principal.session_hash)
            )
            self._audit(con, principal.username, "LOGOUT", "SUCCESS")
            con.commit()

    def revoke_user(self, username: str, actor: str = "LOCAL_ADMIN") -> int:
        with self._db() as con:
            cursor = con.execute(
                "UPDATE operator_sessions SET revoked_at=? "
                "WHERE username=? AND revoked_at IS NULL",
                (int(self.clock()), username)
            )
            self._audit(con, actor, "USER_SESSIONS_REVOKED", "SUCCESS")
            con.commit()
            return cursor.rowcount

    def require_scope(self, principal: Principal, vehicle_id: str,
                      *, write: bool = False) -> None:
        if not principal.allowed(vehicle_id):
            raise AccessDenied("Aircraft access denied")
        if write and not principal.can_write():
            raise AccessDenied("Pilot or administrator role required")

    def audit_recent(self, maximum: int = 100) -> list[dict]:
        with self._db() as con:
            rows = con.execute(
                "SELECT when_utc,actor,action,aircraft,result "
                "FROM operator_audit ORDER BY id DESC LIMIT ?", (min(200, max(1, maximum)),)
            ).fetchall()
        return [dict(row) for row in rows]


def main():
    parser = argparse.ArgumentParser(description="Local-only operator credential provisioning")
    parser.add_argument("--db", default="data/vihanga-dev.sqlite3")
    sub = parser.add_subparsers(dest="operation", required=True)
    register = sub.add_parser("enroll")
    register.add_argument("--user", required=True)
    register.add_argument("--role", required=True, choices=sorted(ROLES))
    register.add_argument("--aircraft", action="append", default=[])
    revoke = sub.add_parser("revoke-sessions")
    revoke.add_argument("--user", required=True)
    args = parser.parse_args()
    manager = OperatorStore(args.db)
    if args.operation == "enroll":
        password = getpass("New password (not echoed): ")
        confirmation = getpass("Confirm password: ")
        if password != confirmation:
            raise SystemExit("Passwords did not match")
        manager.provision(args.user, password, args.role, args.aircraft)
        print("Operator provisioned; no password stored in command history.")
    else:
        print("Revoked", manager.revoke_user(args.user), "session(s).")


if __name__ == "__main__":
    main()
