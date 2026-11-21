import { describe, expect, it } from "vitest";
import { BrowserMavlinkState, MavlinkStream, mavlinkX25 } from "./BrowserSerial";

const extra: Record<number, number> = {0:50,30:39,65:118,253:83};

function packet(id:number, body:Uint8Array, sysid=1, component=1): Uint8Array {
  const header = [253,body.length,0,0,0,sysid,component,id&255,(id>>8)&255,(id>>16)&255];
  const crc = mavlinkX25([...header.slice(1), ...body], extra[id]);
  return new Uint8Array([...header,...body,crc&255,crc>>8]);
}
function heartbeat(): Uint8Array {
  const payload = new Uint8Array(9);
  const view = new DataView(payload.buffer);
  view.setUint32(0,5,true);
  payload[4] = 2; payload[5] = 3; payload[6] = 0x80;
  return packet(0,payload);
}
function attitude(): Uint8Array {
  const payload = new Uint8Array(28);
  const view = new DataView(payload.buffer);
  view.setFloat32(4,0.1,true);
  view.setFloat32(8,-0.2,true);
  view.setFloat32(12,0.3,true);
  return packet(30,payload);
}
function radio(): Uint8Array {
  const payload = new Uint8Array(42);
  const v = new DataView(payload.buffer);
  for (let i=0;i<6;i++) v.setUint16(4+i*2,1500,true);
  v.setUint8(40,6);v.setUint8(41,255);
  return packet(65,payload);
}
function statustext(text:string): Uint8Array {
  const p = new Uint8Array(51);
  p[0]=4;
  p.set(new TextEncoder().encode(text).slice(0,50),1);
  return packet(253,p);
}
describe("browser MAVLink2 receive-only validated stream", () => {
  it("accepts actual CRC-valid fragmented heartbeat and attitude", () => {
    const state = new BrowserMavlinkState("AH-HW-001",1);
    const hb = heartbeat(), att=attitude();
    state.consume(hb.slice(0,4),1000);
    expect(state.snapshot(1100).heartbeat_fresh).toBe(false);
    state.consume(hb.slice(4),1100);
    state.consume(att,1100);
    const out=state.snapshot(1200);
    expect(out.status).toBe("LIVE");
    expect(out.heartbeat_fresh).toBe(true);
    expect(out.attitude_fresh).toBe(true);
    expect(out.roll_deg).toBeCloseTo(5.73,1);
    expect(out.pitch_deg).toBeCloseTo(-11.46,1);
    expect(out.armed).toBe(true);
    expect(out.flight_control_enabled).toBe(false);
    expect(out.transport).toBe("BROWSER_SERIAL_READ_ONLY");
    expect(state.snapshot(6000).status).toBe("STALE");
  });

  it("rejects bad CRC and foreign aircraft/component rather than faking a backup FC", () => {
    const gate = new MavlinkStream(1);
    const corrupt=heartbeat();
    corrupt[corrupt.length-1]^=255;
    expect(gate.consume(corrupt)).toHaveLength(0);
    expect(gate.consume(packet(0,new Uint8Array(9),2))).toHaveLength(0);
    expect(gate.consume(packet(0,new Uint8Array(9),1,68))).toHaveLength(0);
    expect(gate.consume(heartbeat())).toHaveLength(1);
  });

  it("never treats static receiver PWM with unknown RSSI as verified RF presence", () => {
    const state=new BrowserMavlinkState("AH-HW-001",1);
    state.consume(radio(),1000);
    const reading=state.snapshot(1100);
    expect(reading.rc_input_status).toBe("CHANNELS_REPORTED");
    expect(reading.rc_channel_count).toBe(6);
    expect(reading.rc_rssi_raw).toBeNull();
    expect(reading.heartbeat_fresh).toBe(false);
    expect(reading.backup_status).not.toBe("LIVE");
    state.consume(statustext("Radio Failsafe"),1200);
    expect(state.snapshot(1300).rc_input_status).toBe("FAILSAFE");
    state.consume(radio(),1400);
    expect(state.snapshot(1500).rc_input_status).toBe("FAILSAFE");
    state.consume(statustext("Radio Failsafe Cleared"),1600);
    expect(state.snapshot(1700).rc_input_status).toBe("CHANNELS_REPORTED");
  });
});
