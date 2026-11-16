"""Identity lifecycle; uses a real temporary SQLite database and fake clock."""
import pytest

from vihanga.operator_auth import AccessDenied, OperatorStore


ADMIN_PASSWORD = "A_safe_admin_password-2026!"
PILOT_PASSWORD = "A_safe_pilot_password-2026!"


def test_operator_role_validation_and_scope_enrollment(tmp_path):
    auth = OperatorStore(tmp_path / "operators.sqlite3")
    auth.provision("admin-one", ADMIN_PASSWORD, "ADMIN")
    auth.provision("pilot-one", PILOT_PASSWORD, "PILOT", ["AH-HW-001"])
    assert auth.count_accounts() == 2
    with pytest.raises(ValueError, match="already exists"):
        auth.provision("admin-one", ADMIN_PASSWORD, "ADMIN")
    with pytest.raises(ValueError, match="require aircraft scopes"):
        auth.provision("viewer-b", PILOT_PASSWORD, "VIEWER")
    with pytest.raises(ValueError, match="global scope"):
        auth.provision("admin-two", ADMIN_PASSWORD, "ADMIN", ["AH-HW-001"])
    with pytest.raises(ValueError, match="14-256"):
        auth.provision("short", "12345678", "ADMIN")


def test_session_scope_csrf_revocation_and_absolute_expiration(tmp_path):
    current = [100000.0]
    auth = OperatorStore(tmp_path / "session.sqlite3", clock=lambda: current[0])
    auth.provision("pilot-one", PILOT_PASSWORD, "PILOT", ["AH-HW-001"])
    token, csrf, principal = auth.login("pilot-one", PILOT_PASSWORD)
    assert "A_safe" not in token and token != csrf
    assert principal.role == "PILOT"
    assert principal.allowed("AH-HW-001")
    assert not principal.allowed("OTHER-001")
    assert principal.can_write()
    assert auth.authorize(token).username == "pilot-one"
    with pytest.raises(AccessDenied, match="CSRF"):
        auth.authorize(token, mutation=True)
    with pytest.raises(AccessDenied, match="CSRF"):
        auth.authorize(token, mutation=True, csrf="wrong")
    assert auth.authorize(token, mutation=True, csrf=csrf).username == "pilot-one"
    with pytest.raises(AccessDenied, match="Aircraft"):
        auth.require_scope(principal, "OTHER-001", write=True)
    current[0] += 1801
    with pytest.raises(AccessDenied, match="expired"):
        auth.authorize(token)
    other_token, other_csrf, other = auth.login("pilot-one", PILOT_PASSWORD)
    assert other_token != token and other_csrf != csrf
    assert auth.revoke_user("pilot-one") == 1
    with pytest.raises(AccessDenied, match="revoked"):
        auth.authorize(other_token)
    assert any(e["action"] == "USER_SESSIONS_REVOKED" for e in auth.audit_recent())


def test_failed_login_throttling_is_generic_and_recovers(tmp_path):
    now = [100.0]
    auth = OperatorStore(tmp_path / "limit.sqlite3", clock=lambda: now[0])
    auth.provision("admin-one", ADMIN_PASSWORD, "ADMIN")
    for _ in range(5):
        with pytest.raises(AccessDenied, match="Invalid credentials"):
            auth.login("admin-one", "this-is-the-wrong-password")
    with pytest.raises(AccessDenied, match="Invalid credentials"):
        auth.login("admin-one", ADMIN_PASSWORD)
    now[0] += 301
    token, csrf, principal = auth.login("admin-one", ADMIN_PASSWORD)
    assert principal.role == "ADMIN"
    assert principal.allowed("ANY-001")
    assert auth.authorize(token, mutation=True, csrf=csrf).role == "ADMIN"
    auth.revoke(principal)
    with pytest.raises(AccessDenied):
        auth.authorize(token)
    audit = auth.audit_recent()
    assert any(event["action"] == "LOGIN" and event["result"] == "DENIED" for event in audit)
    assert any(event["action"] == "LOGOUT" for event in audit)
    assert all(ADMIN_PASSWORD not in str(event) for event in audit)
