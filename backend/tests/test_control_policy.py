from dataclasses import replace
from io import BytesIO
from uuid import uuid4

import pytest
from pymavlink.dialects.v20 import ardupilotmega as mavlink

from vihanga.control import Authority, Action, Status, Refused, VehicleHealth


def setup():
    instant = [100.0]
    authority = Authority(clock=lambda: instant[0])
    health = VehicleHealth(
        vehicle_id="TEST-001", system_id=1, heartbeat_fresh=True,
        attitude_fresh=True, gps_fix=3, home_verified=True,
        battery_pct=90, failsafe=False, armed=True, mode="LOITER",
        altitude_m=0, operator_override_available=True,
        is_ardupilot_sitl=True, observed_at=100.0)
    lease = authority.claim("TEST-001", "pilot-a", "PILOT", health)
    return authority, lease, health, instant


def issue(authority, lease, health, action=Action.RTL, sequence=1, **extra):
    return authority.issue(
        lease_token=lease.token, vehicle=lease.vehicle_id,
        pilot=lease.pilot_identity, command_id=str(uuid4()),
        sequence=sequence, action=action, deadline=authority.clock()+4,
        health=health, **extra)


def test_sitl_rtl_command_is_real_mavlink_and_requires_ack_plus_observed_mode():
    authority, lease, health, instant = setup()
    command = issue(authority, lease, health)
    packet = authority.encode(command.command_id)
    parsed = mavlink.MAVLink(None).parse_buffer(packet)
    assert len(parsed) == 1
    assert parsed[0].get_type() == "COMMAND_LONG"
    assert parsed[0].command == mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH
    assert parsed[0].target_system == 1
    assert command.status == Status.ENCODED
    assert not authority.observe(command.command_id, replace(health, mode="RTL"))
    ack = mavlink.MAVLink_command_ack_message(mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH, 0)
    assert not authority.accept_fc_ack(command.command_id, ack, source_system=2)
    assert authority.accept_fc_ack(command.command_id, ack, source_system=1)
    assert command.status == Status.FC_ACKNOWLEDGED
    assert not authority.observe(command.command_id, health)
    instant[0] += .1
    assert authority.observe(command.command_id, replace(health, mode="RTL", observed_at=instant[0]))
    assert command.status == Status.OBSERVED
    assert command.vehicle_id not in authority.active


def test_no_simulator_flag_or_no_fresh_health_refuses_control():
    authority, lease, health, instant = setup()
    for patch in (
        {"is_ardupilot_sitl":False}, {"heartbeat_fresh":False},
        {"attitude_fresh":False}, {"battery_pct":None},
        {"failsafe":True}, {"operator_override_available":False},
        {"gps_fix":2}, {"home_verified":False}
    ):
        with pytest.raises(Refused):
            issue(authority, lease, replace(health, **patch))


def test_duplicate_lease_replay_expiration_and_reconnect_revocation():
    authority, lease, health, instant = setup()
    with pytest.raises(Refused, match="AIRCRAFT_ALREADY_LEASED"):
        authority.claim("TEST-001", "pilot-b", "PILOT", health)
    command = issue(authority, lease, health, sequence=1)
    with pytest.raises(Refused, match="COMMAND_ALREADY_PENDING"):
        issue(authority, lease, health, sequence=2)
    authority.revoke("TEST-001", "CLOUD_LINK_LOST")
    assert command.status == Status.UNKNOWN
    with pytest.raises(Refused, match="NO_ACTIVE_PILOT_LEASE"):
        issue(authority, lease, health, sequence=2)
    next_lease = authority.claim("TEST-001", "pilot-a", "PILOT", health)
    assert next_lease.token != lease.token
    with pytest.raises(Refused, match="REPLAY_OR_INVALID_SEQUENCE"):
        issue(authority, next_lease, health, sequence=0)
    new_command = issue(authority, next_lease, health, sequence=1)
    instant[0] += 6
    with pytest.raises(Refused, match="COMMAND_EXPIRED"):
        authority.encode(new_command.command_id)
    assert new_command.status == Status.TIMED_OUT
    assert new_command.vehicle_id not in authority.active


def test_fc_rejection_and_unknown_or_foreign_ack_do_not_claim_success():
    authority, lease, health, instant = setup()
    command = issue(authority, lease, health)
    authority.encode(command.command_id)
    wrong_command = mavlink.MAVLink_command_ack_message(mavlink.MAV_CMD_NAV_TAKEOFF, 0)
    assert not authority.accept_fc_ack(command.command_id, wrong_command, source_system=1)
    rejected = mavlink.MAVLink_command_ack_message(mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH, mavlink.MAV_RESULT_DENIED)
    assert authority.accept_fc_ack(command.command_id, rejected, source_system=1)
    assert command.status == Status.REJECTED
    assert command.reason.startswith("FC_RESULT_")
    assert not authority.observe(command.command_id, replace(health, mode="RTL"))


def test_sitl_takeoff_requires_verified_arm_nav_and_reasonable_altitude():
    authority, lease, health, instant = setup()
    for altitude in (None, -1, 0, 120, float("inf")):
        with pytest.raises(Refused):
            issue(authority, lease, health, action=Action.TAKEOFF, altitude_m=altitude)
    command = issue(authority, lease, health, action=Action.TAKEOFF, altitude_m=20)
    packet = authority.encode(command.command_id)
    parsed = mavlink.MAVLink(None).parse_buffer(packet)[0]
    assert parsed.command == mavlink.MAV_CMD_NAV_TAKEOFF
    assert parsed.param7 == 20
    ack = mavlink.MAVLink_command_ack_message(mavlink.MAV_CMD_NAV_TAKEOFF, 0)
    assert authority.accept_fc_ack(command.command_id, ack, source_system=1)
    assert not authority.observe(command.command_id, replace(health, altitude_m=2))
    instant[0] += .1
    assert authority.observe(command.command_id, replace(health, altitude_m=12, observed_at=instant[0]))


def test_no_flight_command_route_exists_in_gcs_api(tmp_path):
    from fastapi.testclient import TestClient
    from vihanga.app import create_app
    c = TestClient(create_app(tmp_path / "policy.sqlite3"))
    assert c.post("/api/v1/control/execute", json={"action":"ARM"}).status_code == 404


def test_post_ack_observation_requires_fresh_real_time_evidence():
    authority, lease, health, instant = setup()
    command = issue(authority, lease, health)
    authority.encode(command.command_id)
    ack = mavlink.MAVLink_command_ack_message(mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH, 0)
    assert authority.accept_fc_ack(command.command_id, ack, source_system=1)
    assert not authority.observe(command.command_id, replace(health, mode="RTL"))
    assert not authority.observe(command.command_id, replace(health, mode="RTL", observed_at=float("nan")))
    assert not authority.observe(command.command_id, replace(health, mode="RTL", observed_at=101.0))
    instant[0] += 2.1
    assert not authority.observe(command.command_id, replace(health, mode="RTL", observed_at=100.05))
    assert authority.observe(command.command_id, replace(health, mode="RTL", observed_at=instant[0]))
    assert command.status == Status.OBSERVED


def test_nonfinite_health_timestamp_cannot_grant_authority():
    authority, lease, health, _ = setup()
    with pytest.raises(Refused, match="STALE_HEALTH"):
        issue(authority, lease, replace(health, observed_at=float("nan")))
