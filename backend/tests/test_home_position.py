from pymavlink.dialects.v20 import ardupilotmega as dialect
from vihanga.telemetry import MAVLinkProjector


def test_home_requires_fc_message_from_selected_system():
    projector = MAVLinkProjector(1)
    home = dialect.MAVLink_home_position_message(120000000, 770000000, 910000,
                                                  0, 0, 0, [1, 0, 0, 0], 0, 0, 0)
    for system, component in [(2, 1), (1, 68)]:
        projector.push(home.pack(dialect.MAVLink(None, srcSystem=system, srcComponent=component)))
        assert projector.snapshot()["home"] is None
    projector.push(home.pack(dialect.MAVLink(None, srcSystem=1, srcComponent=1)))
    assert projector.snapshot()["home"] == {"latitude": 12, "longitude": 77, "altitude_msl_m": 910}
