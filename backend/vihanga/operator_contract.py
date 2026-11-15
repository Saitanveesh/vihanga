"""Vihanga operator operations catalog and non-actuating MAVLink read requests.

The catalog describes a complete GCS surface, not implemented capabilities.
Only explicitly allowlisted parameter/message *requests* are serializable here.
Flight actuation and cloud transmission are deliberately absent from this module.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from io import BytesIO
import re

from pymavlink.dialects.v20 import ardupilotmega as mavlink
from pydantic import BaseModel, ConfigDict, Field, field_validator


class BenchRequest(str, Enum):
    FC_VERSION = "FC_VERSION"
    STATUS = "STATUS"
    GPS = "GPS"
    GPS2 = "GPS2"
    EKF = "EKF"
    RC = "RC"
    BATTERY = "BATTERY"
    HOME = "HOME"
    EXTENDED_STATE = "EXTENDED_STATE"
    PARAMETER_LIST = "PARAMETER_LIST"
    PARAMETER_READ = "PARAMETER_READ"
    MISSION_SUMMARY = "MISSION_SUMMARY"


# MAVLink message IDs; these are read requests, not setpoints or actuator commands.
MESSAGE_IDS = {
    BenchRequest.FC_VERSION: 148,             # AUTOPILOT_VERSION
    BenchRequest.STATUS: 1,                   # SYS_STATUS
    BenchRequest.GPS: 24,                     # GPS_RAW_INT
    BenchRequest.GPS2: 124,                   # GPS2_RAW
    BenchRequest.EKF: 193,                   # EKF_STATUS_REPORT
    BenchRequest.RC: 65,                     # RC_CHANNELS
    BenchRequest.BATTERY: 147,                # BATTERY_STATUS
    BenchRequest.HOME: 242,                   # HOME_POSITION
    BenchRequest.EXTENDED_STATE: 245,         # EXTENDED_SYS_STATE
}


class BenchQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: BenchRequest
    parameter: str | None = Field(default=None, max_length=16)

    @field_validator("parameter")
    @classmethod
    def safe_parameter_name(cls, value: str | None) -> str | None:
        if value is not None and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,15}", value):
            raise ValueError("Invalid MAVLink parameter name")
        return value

    def check(self) -> None:
        if self.query == BenchRequest.PARAMETER_READ and not self.parameter:
            raise ValueError("A parameter name is required")
        if self.query != BenchRequest.PARAMETER_READ and self.parameter is not None:
            raise ValueError("Parameter name is only valid for PARAMETER_READ")


def encode_bench_query(query: BenchQuery, fc_system_id: int) -> bytes:
    """Only read-only MAVLink protocol messages; never ARM/MODE/SET/RC_OVERRIDE."""
    query.check()
    if not 1 <= fc_system_id <= 254:
        raise ValueError("Invalid flight-controller system ID")
    if query.query in MESSAGE_IDS:
        params = [0.0] * 7
        params[0] = float(MESSAGE_IDS[query.query])
        message = mavlink.MAVLink_command_long_message(
            fc_system_id, 1, mavlink.MAV_CMD_REQUEST_MESSAGE, 0, *params
        )
    elif query.query == BenchRequest.PARAMETER_LIST:
        message = mavlink.MAVLink_param_request_list_message(fc_system_id, 1)
    elif query.query == BenchRequest.PARAMETER_READ:
        assert query.parameter is not None
        message = mavlink.MAVLink_param_request_read_message(
            fc_system_id, 1, query.parameter.encode("ascii"), -1
        )
    elif query.query == BenchRequest.MISSION_SUMMARY:
        message = mavlink.MAVLink_mission_request_list_message(
            fc_system_id, 1, mavlink.MAV_MISSION_TYPE_MISSION
        )
    else:
        raise ValueError("Unsupported read request")

    writer = mavlink.MAVLink(BytesIO(), srcSystem=255, srcComponent=190)
    result = message.pack(writer)
    if len(result) > 300:
        raise ValueError("Unexpected oversized MAVLink request")
    return result


@dataclass(frozen=True)
class Operation:
    code: str
    label: str
    group: str
    risk: str
    requirement: str
    bench_query: BenchRequest | None = None


OPERATIONS: tuple[Operation, ...] = (
    Operation("ARM", "Arm motors", "FLIGHT", "CRITICAL", "PILOT_LEASE"),
    Operation("DISARM", "Disarm motors", "FLIGHT", "CRITICAL", "PILOT_LEASE"),
    Operation("TAKEOFF", "Take off", "FLIGHT", "CRITICAL", "FLIGHT_CLEARANCE"),
    Operation("LAND", "Land", "FLIGHT", "CRITICAL", "FLIGHT_CLEARANCE"),
    Operation("RTL", "Return to launch", "FLIGHT", "CRITICAL", "HOME_VERIFIED"),
    Operation("HOLD", "Hold / brake", "FLIGHT", "HIGH", "MODE_AUTHORITY"),
    Operation("PAUSE", "Pause mission", "FLIGHT", "HIGH", "MODE_AUTHORITY"),
    Operation("RESUME", "Resume mission", "FLIGHT", "HIGH", "MISSION_AUTHORITY"),
    Operation("GUIDED_TARGET", "Guided waypoint", "NAVIGATION", "CRITICAL", "NAVIGATION_CLEARANCE"),
    Operation("SET_MODE", "Change flight mode", "NAVIGATION", "HIGH", "MODE_AUTHORITY"),
    Operation("SET_HOME", "Set home position", "NAVIGATION", "HIGH", "NAVIGATION_CLEARANCE"),
    Operation("SPEED", "Set target speed", "NAVIGATION", "HIGH", "MODE_AUTHORITY"),
    Operation("GEOFENCE", "Geofence settings", "NAVIGATION", "HIGH", "PARAMETER_AUTHORITY"),
    Operation("MISSION_UPLOAD", "Upload mission", "MISSIONS", "HIGH", "MISSION_AUTHORITY"),
    Operation("MISSION_DOWNLOAD", "Download mission", "MISSIONS", "READ", "BENCH_READ", BenchRequest.MISSION_SUMMARY),
    Operation("MISSION_CLEAR", "Clear onboard mission", "MISSIONS", "HIGH", "MISSION_AUTHORITY"),
    Operation("MISSION_START", "Start mission", "MISSIONS", "CRITICAL", "MISSION_AUTHORITY"),
    Operation("PARAM_LIST", "Read all parameters", "PARAMETERS", "READ", "BENCH_READ", BenchRequest.PARAMETER_LIST),
    Operation("PARAM_READ", "Read parameter", "PARAMETERS", "READ", "BENCH_READ", BenchRequest.PARAMETER_READ),
    Operation("PARAM_WRITE", "Write parameter", "PARAMETERS", "HIGH", "PARAMETER_AUTHORITY"),
    Operation("PARAM_REFRESH", "Refresh parameters", "PARAMETERS", "READ", "BENCH_READ", BenchRequest.PARAMETER_LIST),
    Operation("FC_VERSION", "Flight controller version", "DIAGNOSTICS", "READ", "BENCH_READ", BenchRequest.FC_VERSION),
    Operation("STATUS", "System status", "DIAGNOSTICS", "READ", "BENCH_READ", BenchRequest.STATUS),
    Operation("GPS", "GPS 1 status", "DIAGNOSTICS", "READ", "BENCH_READ", BenchRequest.GPS),
    Operation("GPS2", "GPS 2 status", "DIAGNOSTICS", "READ", "BENCH_READ", BenchRequest.GPS2),
    Operation("EKF", "EKF diagnostics", "DIAGNOSTICS", "READ", "BENCH_READ", BenchRequest.EKF),
    Operation("RC", "Radio channels", "DIAGNOSTICS", "READ", "BENCH_READ", BenchRequest.RC),
    Operation("BATTERY", "Battery status", "DIAGNOSTICS", "READ", "BENCH_READ", BenchRequest.BATTERY),
    Operation("HOME", "Home position", "DIAGNOSTICS", "READ", "BENCH_READ", BenchRequest.HOME),
    Operation("EXTENDED_STATE", "Extended flight state", "DIAGNOSTICS", "READ", "BENCH_READ", BenchRequest.EXTENDED_STATE),
    Operation("CALIBRATE_ACCEL", "Accelerometer calibration", "SETUP", "HIGH", "CALIBRATION_AUTHORITY"),
    Operation("CALIBRATE_COMPASS", "Compass calibration", "SETUP", "HIGH", "CALIBRATION_AUTHORITY"),
    Operation("CALIBRATE_RADIO", "RC calibration", "SETUP", "HIGH", "CALIBRATION_AUTHORITY"),
    Operation("CALIBRATE_ESC", "ESC calibration", "SETUP", "CRITICAL", "PROPELLER_FREE_GATE"),
    Operation("MOTOR_TEST", "Motor output test", "SETUP", "CRITICAL", "PROPELLER_FREE_GATE"),
    Operation("SERVO_TEST", "Servo output test", "SETUP", "HIGH", "PROPELLER_FREE_GATE"),
    Operation("REBOOT_FC", "Reboot flight controller", "SETUP", "HIGH", "MAINTENANCE_AUTHORITY"),
    Operation("FLIGHT_LOGS", "Flight log directory", "LOGS", "READ", "LOG_DOWNLOAD"),
    Operation("RC_OVERRIDE", "Manual joystick / RC override", "FLIGHT", "CRITICAL", "PHYSICAL_RC_PRIORITY"),
)
OPERATION_BY_CODE = {entry.code: entry for entry in OPERATIONS}


def catalog(*, bench_enabled: bool, local_serial: bool, connected: bool) -> dict:
    operations = []
    for op in OPERATIONS:
        permitted = bool(op.bench_query and bench_enabled and local_serial and connected)
        reason = ("AVAILABLE_LOCAL_BENCH_READ" if permitted else
                  "BENCH_OPT_IN_REQUIRED" if op.bench_query and not bench_enabled else
                  "LOCAL_SERIAL_REQUIRED" if op.bench_query and not local_serial else
                  "SERIAL_NOT_CONNECTED" if op.bench_query and not connected else
                  "CONTROL_AUTHORITY_NOT_IMPLEMENTED")
        operations.append({
            "code": op.code, "label": op.label, "group": op.group,
            "risk": op.risk, "requirement": op.requirement,
            "enabled": permitted, "status": "READY" if permitted else "LOCKED",
            "reason": reason, "bench_query": op.bench_query.value if op.bench_query else None,
        })
    return {
        "physical_flight_control_enabled": False,
        "cloud_command_dispatch_enabled": False,
        "read_only_bench_enabled": bench_enabled and local_serial and connected,
        "operations": operations,
    }
