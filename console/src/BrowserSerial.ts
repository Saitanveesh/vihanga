/* Chrome Web Serial MAVLink receive-only backup.
 * No port.write(), no commands, no outbound cloud telemetry endpoint.
 * Browser permission is explicit; CRC-valid FC-origin frames only.
 */
import type { Telemetry } from "./api";

export interface BrowserSerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  open(options: {baudRate: number}): Promise<void>;
  close(): Promise<void>;
  getInfo(): {usbVendorId?: number; usbProductId?: number};
}
export interface BrowserSerialAPI {
  requestPort(): Promise<BrowserSerialPort>;
  getPorts(): Promise<BrowserSerialPort[]>;
}
export function getBrowserSerial(): BrowserSerialAPI | null {
  if (typeof navigator === "undefined" || !window.isSecureContext) return null;
  return (navigator as Navigator & {serial?: BrowserSerialAPI}).serial ?? null;
}

const crcExtras: Readonly<Record<number, number>> = {
  0:50, 1:124, 24:24, 30:39, 33:104, 35:244,
  65:118, 74:20, 109:185, 242:104, 253:83
};
const MAX_BUFFER = 8192;

function x25Step(crc: number, value: number): number {
  let tmp = value ^ (crc & 255);
  tmp ^= (tmp << 4) & 255;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 65535;
}
export function mavlinkX25(bytes: number[], extra: number): number {
  let crc = 65535;
  for (const value of bytes) crc = x25Step(crc, value);
  return x25Step(crc, extra);
}
export interface VerifiedFrame {
  id: number;
  payload: Uint8Array;
}
export class MavlinkStream {
  private bytes: number[] = [];
  constructor(private readonly fcSystemId: number) {}

  consume(chunk: Uint8Array): VerifiedFrame[] {
    const output: VerifiedFrame[] = [];
    this.bytes.push(...chunk);
    if (this.bytes.length > MAX_BUFFER) this.bytes = this.bytes.slice(-MAX_BUFFER / 2);
    while (this.bytes.length >= 8) {
      if (this.bytes[0] !== 253 && this.bytes[0] !== 254) {
        this.bytes.shift(); continue;
      }
      const v2 = this.bytes[0] === 253;
      const header = v2 ? 10 : 6;
      if (this.bytes.length < header) break;
      const length = this.bytes[1];
      const extraSig = v2 && (this.bytes[2] & 1) ? 13 : 0;
      const size = header + length + 2 + extraSig;
      if (size > 300 || (v2 && (this.bytes[2] & ~1) !== 0)) {
        this.bytes.shift(); continue;
      }
      if (this.bytes.length < size) break;
      const packet = this.bytes.slice(0, size);
      const id = v2 ? packet[7] | packet[8] << 8 | packet[9] << 16 : packet[5];
      const extra = crcExtras[id];
      const source = v2 ? packet[5] : packet[3];
      const component = v2 ? packet[6] : packet[4];
      const crcStart = header + length;
      const expected = packet[crcStart] | packet[crcStart + 1] << 8;
      const actual = extra === undefined ? -1 :
        mavlinkX25(packet.slice(1, crcStart), extra);
      if (actual === expected && source === this.fcSystemId &&
          (component === 1 || (id === 109 && component === 68))) {
        output.push({id, payload: new Uint8Array(packet.slice(header, crcStart))});
        this.bytes.splice(0, size);
      } else {
        // Try next magic byte instead of treating corrupt packet as a frame.
        this.bytes.shift();
      }
    }
    return output;
  }
}

const toDegrees = (rad: number) => rad * 180 / Math.PI;
function finiteRange(v: number, bound: number): number | null {
  return Number.isFinite(v) && Math.abs(v) <= bound ? +v.toFixed(2) : null;
}

export class BrowserMavlinkState {
  private readonly stream: MavlinkStream;
  private fields: Record<string, number | boolean | string> = {};
  private last: Record<string, number> = {};
  private frameTimes: number[] = [];
  private frames = 0;
  private currentMode: string | null = null;
  private home: Telemetry["home"] = null;
  private failSafe: boolean | null = null;
  constructor(private readonly aircraftId: string, fcSystemId: number) {
    this.stream = new MavlinkStream(fcSystemId);
  }
  private put(key: string, value: number | boolean | string, now: number) {
    this.fields[key] = value;
    this.last[key] = now;
  }
  consume(data: Uint8Array, now = performance.now()) {
    const frames = this.stream.consume(data);
    for (const {id, payload} of frames) {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      this.frames += 1;
      this.frameTimes.push(now);
      if (id === 0 && payload.length >= 9) {
        this.put("heartbeat", true, now);
        this.put("armed", (view.getUint8(6) & 128) !== 0, now);
        const mode = view.getUint32(0, true);
        this.currentMode = "MODE " + mode;
      } else if (id === 242 && payload.length) {
        // MAVLink 2 removes trailing zero bytes, including zero altitude.
        const raw = new Uint8Array(12);
        raw.set(payload.subarray(0, 12));
        const fields = new DataView(raw.buffer);
        const latitude = fields.getInt32(0, true) / 1e7, longitude = fields.getInt32(4, true) / 1e7;
        this.home = Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && (latitude !== 0 || longitude !== 0)
          ? {latitude, longitude, altitude_msl_m: fields.getInt32(8, true) / 1000} : null;
      } else if (id === 30 && payload.length >= 16) {
        const roll = finiteRange(toDegrees(view.getFloat32(4, true)), 180);
        const pitch = finiteRange(toDegrees(view.getFloat32(8, true)), 90);
        const yaw = finiteRange(toDegrees(view.getFloat32(12, true)), 360);
        if (roll !== null && pitch !== null && yaw !== null) {
          this.put("roll_deg", roll, now);
          this.put("pitch_deg", pitch, now);
          this.put("yaw_deg", yaw, now);
        }
      } else if (id === 1 && payload.length >= 19) {
        const voltage = view.getUint16(14, true);
        if (voltage !== 65535) this.put("voltage_v", voltage / 1000, now);
        if (payload.length >= 31) {
          const battery = view.getInt8(30);
          if (battery >= 0 && battery <= 100) this.put("battery_pct", battery, now);
        }
        const present = view.getUint32(0, true), enabled = view.getUint32(4, true);
        const healthy = view.getUint32(8, true), flag = 1 << 16;
        if ((present & flag) !== 0) {
          this.put("rc_sensor", (enabled & flag) === 0 ? "DISABLED" :
            (healthy & flag) !== 0 ? "HEALTHY" : "FAULT", now);
        }
      } else if (id === 65 && payload.length >= 42) {
        let valid = 0;
        for (let index = 0; index < 18; index++) {
          if (index >= view.getUint8(40)) break;
          const pwm = view.getUint16(4 + index * 2, true);
          if (pwm >= 800 && pwm <= 2200) valid++;
        }
        if (valid) {
          this.put("rc_channels", valid, now);
          const rssi = view.getUint8(41);
          if (rssi < 255) this.put("rc_rssi", rssi, now);
        }
      } else if (id === 35 && payload.length >= 22) {
        let valid = 0;
        for (let index = 0; index < 8; index++) {
          const pwm = view.getUint16(4 + index * 2, true);
          if (pwm >= 800 && pwm <= 2200) valid++;
        }
        if (valid) {
          this.put("rc_channels", valid, now);
          const rssi = view.getUint8(21);
          if (rssi < 255) this.put("rc_rssi", rssi, now);
        }
      } else if (id === 24 && payload.length >= 30) {
        this.put("gps_fix_type", view.getUint8(28), now);
        const sats = view.getUint8(29);
        if (sats < 101) this.put("satellites", sats, now);
      } else if (id === 33 && payload.length >= 20) {
        const lat = view.getInt32(4, true) / 1e7;
        const lon = view.getInt32(8, true) / 1e7;
        if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
            (lat !== 0 || lon !== 0)) {
          this.put("latitude", lat, now); this.put("longitude", lon, now);
        }
        this.put("relative_alt_m", view.getInt32(16, true) / 1000, now);
      } else if (id === 74 && payload.length >= 20) {
        const speed = finiteRange(view.getFloat32(4, true), 400);
        const climb = finiteRange(view.getFloat32(12, true), 150);
        if (speed !== null) this.put("groundspeed_mps", speed, now);
        if (climb !== null) this.put("climb_mps", climb, now);
      } else if (id === 253 && payload.length >= 2) {
        const content = new TextDecoder().decode(payload.slice(1, 51)).replace(/\x00.*$/, "").toLowerCase();
        if (content.includes("radio failsafe") || content.includes("rc failsafe")) {
          this.failSafe = /cleared|recovered|ended/.test(content) ? false : true;
        }
      }
    }
    this.frameTimes = this.frameTimes.filter(stamp => now - stamp < 5000);
  }

  snapshot(now = performance.now()): Telemetry {
    const fresh = (key: string, limit = 3000) =>
      this.last[key] !== undefined && now - this.last[key] <= limit;
    const value = (key: string, limit = 3000): number | null =>
      fresh(key, limit) ? Number(this.fields[key]) : null;
    const hb = fresh("heartbeat");
    const attitude = fresh("roll_deg") && fresh("pitch_deg");
    const status = hb && attitude ? "LIVE" : hb ? "PARTIAL" :
      this.frames ? "STALE" : "WAITING_FOR_FRAMES";
    const fix = value("gps_fix_type", 5000);
    const lat = value("latitude", 3000), lon = value("longitude", 3000);
    const positionValid = fix !== null && fix >= 3;
    const rc = fresh("rc_channels", 5000);
    const sensor = fresh("rc_sensor", 5000) ? String(this.fields.rc_sensor) : null;
    const rcInput = this.failSafe === true ? "FAILSAFE" :
      sensor === "FAULT" ? "FC_FAULT" : sensor === "DISABLED" ? "FC_DISABLED" :
      rc ? "CHANNELS_REPORTED" : sensor === "HEALTHY" ? "FC_HEALTHY" : "NOT_REPORTED";
    return {
      vehicle_id:this.aircraftId,transport:"BROWSER_SERIAL_READ_ONLY",status,
      error_code:null,flight_control_enabled:false,
      heartbeat_fresh:hb,attitude_fresh:attitude,
      home:this.home, latitude:positionValid ? lat : null,longitude:positionValid ? lon : null,
      roll_deg:value("roll_deg"),pitch_deg:value("pitch_deg"),yaw_deg:value("yaw_deg"),
      relative_alt_m:value("relative_alt_m"),groundspeed_mps:value("groundspeed_mps"),
      climb_mps:value("climb_mps"),voltage_v:value("voltage_v"),battery_pct:value("battery_pct"),
      gps_fix_type:fix,satellites:value("satellites", 5000),
      gps2_fix_type:null,gps2_satellites:null,battery_current_a:null,
      rc_input_status:rcInput,rc_failsafe_reported:this.failSafe,
      rc_channels_fresh:rc,rc_channel_count:value("rc_channels", 5000),
      rc_rssi_raw:value("rc_rssi", 5000),rc_message_type:null,
      radio_rssi_raw:null,radio_remote_rssi_raw:null,radio_noise_raw:null,
      radio_rx_errors:null,radio_fixed_packets:null,radio_txbuf_raw:null,
      active_source:"BACKUP",primary_status:"OFFLINE",primary_transport:null,
      backup_status:status,backup_transport:"BROWSER_SERIAL_READ_ONLY",
      backup_error_code:null,backup_heartbeat_fresh:hb,backup_attitude_fresh:attitude,
      airspeed_mps:null,throttle_pct:null,frame_rate_5s_hz: +(this.frameTimes.length/5).toFixed(1),
      mode: hb ? this.currentMode : null,
      armed: hb && fresh("armed") ? Boolean(this.fields.armed) : null,
      age_ms:this.frameTimes.length ? Math.round(now - this.frameTimes.at(-1)!) : null,
      frames_total:this.frames,rejected_frames:0,track_points:0,message_counts:{}
    };
  }
}

export class BrowserSerialReceiver {
  private port: BrowserSerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private loop: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private state: BrowserMavlinkState | null = null;

  async connect(aircraftId: string, sysid: number, baud: number,
                onTelemetry: (sample: Telemetry) => void,
                onError: (reason: string) => void,
                useGranted = false): Promise<void> {
    const serial = getBrowserSerial();
    if (!serial) throw new Error("Chrome Web Serial is unavailable. Use a supported desktop Chromium browser over HTTPS.");
    if (this.running) throw new Error("Browser serial receiver already connected");
    if (!Number.isInteger(sysid) || sysid < 1 || sysid > 254) throw new Error("Invalid FC system ID");
    if (![9600,19200,38400,57600,115200,230400,460800,921600].includes(baud)) throw new Error("Invalid serial baud");
    // requestPort() is called synchronously from the actual user click
    // before any awaits, preserving the Web Serial permission gesture.
    const selected = useGranted
      ? serial.getPorts().then(ports => {
          if (ports.length !== 1) throw new Error("Expected exactly one previously authorized USB radio");
          return ports[0];
        })
      : serial.requestPort();
    this.port = await selected;
    try {
      await this.port.open({baudRate:baud});
      if (!this.port.readable) throw new Error("Selected serial device has no readable stream");
      this.state = new BrowserMavlinkState(aircraftId, sysid);
      this.reader = this.port.readable.getReader();
      this.running = true;
      this.timer = setInterval(() => {
        if (this.running && this.state) onTelemetry(this.state.snapshot());
      }, 500);
      onTelemetry(this.state.snapshot());
      this.loop = this.readLoop(onTelemetry, onError);
    } catch (e) {
      try { await this.port.close(); } catch { /* Port may not have opened */ }
      this.port = null;
      throw e;
    }
  }
  private async readLoop(onTelemetry: (sample: Telemetry) => void,
                         onError: (reason: string) => void): Promise<void> {
    try {
      while (this.running && this.reader) {
        const {value, done} = await this.reader.read();
        if (done) break;
        if (value?.length) this.state?.consume(value);
      }
      if (this.running) onError("USB telemetry device disconnected.");
    } catch {
      if (this.running) onError("USB telemetry read failed. Check cable and port ownership.");
    } finally {
      this.running = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.reader?.releaseLock();
      this.reader = null;
      if (this.state) onTelemetry({...this.state.snapshot(),status:"OFFLINE",
        heartbeat_fresh:false,attitude_fresh:false,backup_status:"OFFLINE"});
    }
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { await this.reader?.cancel(); } catch { /* already gone */ }
    try { await this.loop; } catch { /* error reported by readLoop */ }
    this.loop = null;
    try { await this.port?.close(); } catch { /* hot unplug */ }
    this.port = null;
    this.state = null;
  }
}
