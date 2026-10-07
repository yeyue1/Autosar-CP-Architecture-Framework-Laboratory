export const XCP_PARAMETER_LIMITS = Object.freeze({ gain: [0, 10], filter: [0.01, 1], threshold: [0, 100] });
const DEFAULTS = { gain: 1.6, filter: 0.22, threshold: 48 };

/** Connection / DAQ / calibration workflow only; no ASAM wire protocol parser. */
export class XcpLabSimulator {
  constructor() { this.reset(); }
  reset() {
    this.nowMs = 0; this.connected = false; this.daq = false;
    this.parameters = { ...DEFAULTS }; this.samples = []; this.events = [];
    this.nextSample = 10;
    return this.getSnapshot();
  }
  log(message) {
    this.events.push({ time: this.nowMs, timeMs: this.nowMs, message });
    if (this.events.length > 100) this.events.shift();
  }
  connect() { this.connected = true; this.log('XCP teaching connection established'); return this.getSnapshot(); }
  disconnect() {
    // Link-loss checks run every vehicle tick.  An already disconnected XCP
    // slave is a stable state, not a fresh protocol event on every check.
    if (!this.connected && !this.daq) return this.getSnapshot();
    this.connected = false; this.daq = false;
    this.log('Disconnected; DAQ stopped');
    return this.getSnapshot();
  }
  setDaq(enabled) {
    if (!this.connected) throw new Error('Connect before configuring DAQ');
    this.daq = Boolean(enabled); this.nextSample = this.nowMs + 10;
    this.log(`DAQ ${this.daq ? 'started' : 'stopped'}`);
    return this.getSnapshot();
  }
  validate(name, value) {
    const range = XCP_PARAMETER_LIMITS[name];
    if (!Object.hasOwn(XCP_PARAMETER_LIMITS, name) || !Number.isFinite(value) || value < range[0] || value > range[1]) throw new RangeError(`Invalid calibration: ${name}`);
  }
  calibrate(name, value) {
    if (!this.connected) throw new Error('Connect before calibration');
    this.validate(name, value); this.parameters[name] = value;
    this.log(`${name} = ${value} (RAM calibration)`);
    return this.getSnapshot();
  }
  loadCalibration(values) {
    for (const [name, value] of Object.entries(values)) this.validate(name, value);
    Object.assign(this.parameters, values); this.log('Calibration restored from storage');
    return this.getSnapshot();
  }
  tick(ms, signals = {}) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) throw new RangeError('tick must be 0..60000 ms');
    const end = this.nowMs + ms;
    if (this.connected && this.daq) while (this.nextSample <= end + 1e-9) {
      this.samples.push({ time: this.nextSample, timeMs: this.nextSample, signals: structuredClone(signals), parameters: { ...this.parameters } });
      if (this.samples.length > 240) this.samples.shift();
      this.nextSample += 10;
    }
    this.nowMs = end;
    return this.getSnapshot();
  }
  getSnapshot() { return structuredClone({ nowMs: this.nowMs, connected: this.connected, daq: this.daq, parameters: this.parameters, samples: this.samples, events: this.events }); }
}

export { XcpLabSimulator as XcpSimulator };
