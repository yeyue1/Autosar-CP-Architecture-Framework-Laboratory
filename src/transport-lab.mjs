// Normal-addressing ISO-TP teaching transport. Virtual delays are not CAN bitrate estimates.
// Models CTS flow control, 12-bit FF lengths and integer-millisecond STmin only.
export class TransportSimulator {
  constructor({ canFd = false, blockSize = 2, stMinMs = 10, timeoutMs = 100 } = {}) {
    if (!Number.isInteger(blockSize) || blockSize < 0 || blockSize > 255) throw new Error('blockSize must be 0..255');
    if (!Number.isInteger(stMinMs) || stMinMs < 0 || stMinMs > 127) throw new Error('stMinMs must be 0..127');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= Math.max(1, stMinMs)) throw new Error('timeoutMs must exceed STmin and 1 ms');
    this.canFd = Boolean(canFd);
    this.blockSize = blockSize;
    this.stMinMs = stMinMs;
    this.timeoutMs = timeoutMs;
    this.nowMs = 0;
    this.status = 'idle';
    this.frames = [];
    this.received = [];
    this.buffer = [];
    this.payload = [];
    this.nextAction = null;
    this.dueMs = null;
    this.error = null;
    this.fault = 'none';
    this.faultUsed = false;
  }

  setFault(fault) {
    if (!['none', 'drop-fc', 'drop-cf', 'wrong-sequence'].includes(fault)) throw new Error('Unknown transport fault');
    this.fault = fault;
    this.faultUsed = false;
  }

  start(payload = Array.from({ length: 24 }, (_, index) => index)) {
    if (!Array.isArray(payload) || payload.length < 1 || payload.length > 4095 || !payload.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('Payload must contain 1..4095 bytes');
    if (this.status === 'transferring') throw new Error('Transfer already active');
    this.payload = [...payload];
    this.frames = [];
    this.received = [];
    this.buffer = [];
    this.error = null;
    this.status = 'transferring';
    this.sequence = 1;
    this.blockCount = 0;
    this.faultUsed = false;
    this.schedule(payload.length <= (this.canFd ? 62 : 7) ? 'SF' : 'FF', 0);
    return this.getSnapshot();
  }

  schedule(action, delay) {
    this.nextAction = action;
    this.dueMs = this.nowMs + delay;
  }

  frame(type, data, direction = 'TX', dropped = false) {
    const length = this.canFd ? [8, 12, 16, 20, 24, 32, 48, 64].find(size => size >= data.length) : 8;
    const bytes = [...data];
    while (bytes.length < length) bytes.push(0);
    this.frames.push({ time: this.nowMs, type, data: bytes, direction, dropped });
    if (this.frames.length > 1024) this.frames.shift();
  }

  finish(status, error = null) {
    this.status = status;
    this.error = error;
    this.nextAction = null;
    this.dueMs = null;
    if (status === 'complete') this.received = [...this.buffer];
    else this.received = [];
  }

  advance() {
    switch (this.nextAction) {
      case 'SF':
        this.frame('SF', this.canFd && this.payload.length > 7 ? [0, this.payload.length, ...this.payload] : [this.payload.length, ...this.payload]);
        this.buffer = [...this.payload];
        this.finish('complete');
        break;
      case 'FF':
        this.buffer = this.payload.slice(0, this.canFd ? 62 : 6);
        this.offset = this.buffer.length;
        this.frame('FF', [0x10 | (this.payload.length >> 8), this.payload.length & 255, ...this.buffer]);
        this.schedule('FC', 1);
        break;
      case 'FC': {
        const dropped = this.fault === 'drop-fc' && !this.faultUsed;
        this.frame('FC', [0x30, this.blockSize, this.stMinMs], 'RX', dropped);
        if (dropped) {
          this.faultUsed = true;
          this.schedule('FC timeout', this.timeoutMs - 1);
        } else {
          this.blockCount = 0;
          this.receiverDeadline = this.nowMs + this.timeoutMs;
          this.schedule('CF', this.stMinMs);
        }
        break;
      }
      case 'CF': {
        const chunk = this.payload.slice(this.offset, this.offset + (this.canFd ? 63 : 7));
        // Drop the final CF to demonstrate N_Cr, independently of sequence errors.
        const dropped = this.fault === 'drop-cf' && !this.faultUsed && this.offset + chunk.length === this.payload.length;
        const wrongSequence = this.fault === 'wrong-sequence' && !this.faultUsed;
        const sn = wrongSequence ? (this.sequence + 1) & 15 : this.sequence;
        this.frame('CF', [0x20 | sn, ...chunk], 'TX', dropped);
        if (dropped) {
          this.faultUsed = true;
          this.schedule('CF timeout', this.receiverDeadline - this.nowMs);
          break;
        }
        if (sn !== this.sequence) {
          this.faultUsed = true;
          this.finish('error', `CF sequence mismatch: expected ${this.sequence}, received ${sn}`);
          break;
        }
        this.buffer.push(...chunk);
        this.receiverDeadline = this.nowMs + this.timeoutMs;
        this.offset += chunk.length;
        this.sequence = (this.sequence + 1) & 15;
        this.blockCount += 1;
        if (this.offset === this.payload.length) this.finish('complete');
        else if (this.blockSize && this.blockCount === this.blockSize) this.schedule('FC', 1);
        else this.schedule('CF', this.stMinMs);
        break;
      }
      case 'FC timeout': this.finish('timeout', 'N_Bs: flow control not received'); break;
      case 'CF timeout': this.finish('timeout', 'N_Cr: consecutive frame not received'); break;
      default: throw new Error(`Unknown transport action ${this.nextAction}`);
    }
  }

  step() {
    if (this.status === 'transferring') {
      this.nowMs = this.dueMs;
      this.advance();
    }
    return this.getSnapshot();
  }

  tick(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('tick requires nonnegative finite milliseconds');
    const target = this.nowMs + ms;
    while (this.status === 'transferring' && this.dueMs <= target) {
      this.nowMs = this.dueMs;
      this.advance();
    }
    this.nowMs = target;
    return this.getSnapshot();
  }

  getSnapshot() {
    return structuredClone({ nowMs: this.nowMs, status: this.status, frames: this.frames,
      received: this.received, receivedLength: this.buffer.length, payloadLength: this.payload.length,
      nextAction: this.nextAction, dueMs: this.dueMs, error: this.error,
      canFd: this.canFd, blockSize: this.blockSize, stMinMs: this.stMinMs, timeoutMs: this.timeoutMs, fault: this.fault });
  }
}
