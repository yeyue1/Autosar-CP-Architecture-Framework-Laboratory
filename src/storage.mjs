// Deterministic teaching model, not a production AUTOSAR NvM/Fee implementation.
const DEFAULTS = { gain: 1.6, filter: 0.22, threshold: 48, dtcs: [] };
const CAPACITY = 8;
const clone = value => structuredClone(value);
const validDtc = item => typeof item === 'string' ? item.length <= 256
  : Number.isInteger(item) ? item >= 0 && item <= 0xffffff
    : item !== null && typeof item === 'object' && !Array.isArray(item)
      && Object.getPrototypeOf(item) === Object.prototype
      && Number.isInteger(item.id) && item.id >= 0 && item.id <= 0xffffff
      && Number.isInteger(item.status) && item.status >= 0 && item.status <= 255
      && typeof item.label === 'string' && item.label.length <= 512
      && Object.entries(item).every(([key, value]) => key.length <= 64
        && (value === null || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 512) || (typeof value === 'number' && Number.isFinite(value))));

export class StorageSimulator {
  constructor() {
    this.nowMs = 0;
    this.powered = true;
    this.blocks = clone(DEFAULTS);
    this.queue = [];
    this.activeJob = null;
    this.sectors = [[], []];
    this.activeSector = 0;
    this.events = [];
    this.writeProtected = false;
    this.status = 'idle';
    this.gcCount = 0;
    this.sequence = 0;
    this.nextCrcFault = false;
  }

  event(type, detail) {
    this.events.push({ timeMs: this.nowMs, type, detail });
    if (this.events.length > 160) this.events.shift();
  }

  writeBlock(name, value) {
    if (!Object.hasOwn(DEFAULTS, name)) throw new Error(`Unknown NvM block: ${name}`);
    const valid = name === 'dtcs'
      ? Array.isArray(value) && value.length <= 256 && value.every(validDtc)
      : Number.isFinite(value) && (name === 'filter' ? value >= 0.01 && value <= 1 : value >= 0 && value <= (name === 'gain' ? 10 : 100));
    if (!valid) throw new Error(`Invalid value for NvM block: ${name}`);
    if (!this.powered || this.writeProtected || this.queue.length >= 32) {
      this.event('rejected', !this.powered ? 'Power off' : this.writeProtected ? 'Write protected' : 'Queue full');
      return false;
    }
    this.queue.push({ id: ++this.sequence, name, value: clone(value), crcFault: this.nextCrcFault });
    this.nextCrcFault = false;
    this.event('queued', `NvM_WriteBlock(${name}) accepted; durable value unchanged`);
    this.startNext();
    return true;
  }

  readBlock(name) {
    if (!Object.hasOwn(DEFAULTS, name)) throw new Error(`Unknown NvM block: ${name}`);
    return clone(this.blocks[name]);
  }

  setWriteProtected(value) { this.writeProtected = Boolean(value); }
  injectCrcFault() { this.nextCrcFault = true; }

  startNext() {
    if (!this.powered || this.activeJob || !this.queue.length) return;
    this.activeJob = this.queue.shift();
    this.stage('NvM');
  }

  stage(name) {
    this.activeJob.stage = name;
    this.activeJob.remainingMs = 10;
    this.status = name;
    this.event(name, `${this.activeJob.name}: ${name}`);
  }

  latestRecords() {
    const latest = new Map();
    for (const record of this.sectors[this.activeSector]) {
      if (record.committed && record.valid) latest.set(record.name, record);
    }
    return [...latest.values()];
  }

  advanceStage() {
    const job = this.activeJob;
    switch (job.stage) {
      case 'NvM': this.stage('MemIf'); break;
      case 'MemIf': this.stage('Fee'); break;
      case 'Fee':
        this.stage(this.sectors[this.activeSector].length >= CAPACITY ? 'GC copy' : 'Fls');
        break;
      case 'GC copy':
        // Source remains authoritative until the simulated atomic sector switch.
        this.sectors[1 - this.activeSector] = clone(this.latestRecords());
        this.stage('GC switch');
        break;
      case 'GC switch':
        this.activeSector = 1 - this.activeSector;
        this.gcCount += 1;
        this.stage('Fls');
        break;
      case 'Fls':
        this.sectors[this.activeSector].push({ id: job.id, name: job.name, value: clone(job.value), valid: false, committed: false });
        this.stage('verify');
        break;
      case 'verify':
        if (job.crcFault) {
          this.event('crc-error', `${job.name}: CRC mismatch; previous committed value retained`);
          this.activeJob = null;
          this.status = 'crc-error';
          this.startNext();
        } else {
          this.sectors[this.activeSector].at(-1).valid = true;
          this.stage('commit');
        }
        break;
      case 'commit':
        this.sectors[this.activeSector].at(-1).committed = true;
        this.blocks[job.name] = clone(job.value);
        this.event('committed', `${job.name}: durable write complete`);
        this.activeJob = null;
        this.status = 'idle';
        this.startNext();
        break;
      default: throw new Error(`Unknown storage stage: ${job.stage}`);
    }
  }

  tick(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('tick requires nonnegative finite milliseconds');
    let remaining = ms;
    while (this.powered && this.activeJob && remaining > 0) {
      const elapsed = Math.min(remaining, this.activeJob.remainingMs);
      this.nowMs += elapsed;
      remaining -= elapsed;
      this.activeJob.remainingMs -= elapsed;
      if (this.activeJob.remainingMs === 0) this.advanceStage();
    }
    this.nowMs += remaining;
    return this.getSnapshot();
  }

  powerOff() {
    this.powered = false;
    this.queue = [];
    this.activeJob = null;
    this.nextCrcFault = false;
    this.status = 'off';
    this.event('power-off', 'Pending requests cancelled; committed records retained');
  }

  powerOn() {
    if (this.powered) return;
    this.blocks = clone(DEFAULTS);
    for (const record of this.latestRecords()) this.blocks[record.name] = clone(record.value);
    this.powered = true;
    this.status = 'idle';
    this.event('recovered', 'Recovered latest valid committed blocks from active sector');
  }

  getSnapshot() {
    return clone({ nowMs: this.nowMs, powered: this.powered, blocks: this.blocks, queue: this.queue,
      activeJob: this.activeJob, sectors: this.sectors, records: this.sectors[this.activeSector],
      activeSector: this.activeSector, capacity: CAPACITY, events: this.events,
      writeProtected: this.writeProtected, status: this.status, gcCount: this.gcCount });
  }
}
