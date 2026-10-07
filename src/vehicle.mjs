import { BootSimulator } from './engine.mjs';
import { UdsSimulator, parseHexRequest } from './uds.mjs';
import { StorageSimulator } from './storage.mjs';
import { OsSimulator } from './os-lab.mjs';
import { XcpSimulator } from './xcp-lab.mjs';

export const ECU_PROFILES = Object.freeze([
  { id: 'gateway', name: 'Gateway', network: 'PT-CAN / Body-CAN', requestId: 0x7e0, responseId: 0x7e8, appId: 0x5a0, node: 1 },
  { id: 'powertrain', name: 'Powertrain', network: 'PT-CAN', requestId: 0x7e1, responseId: 0x7e9, appId: 0x5a1, node: 2 },
  { id: 'chassis', name: 'Chassis', network: 'PT-CAN', requestId: 0x7e2, responseId: 0x7ea, appId: 0x5a2, node: 3 },
  { id: 'body', name: 'Body', network: 'Body-CAN', requestId: 0x7e3, responseId: 0x7eb, appId: 0x5a3, node: 4 },
]);
export const NM_TIMING = Object.freeze({ repeat: 1600, cycle: 120, timeout: 2000, waitSleep: 1500, heartbeatTimeout: 600 });
const clone = value => structuredClone(value);
const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const bound = (list, value, limit = 300) => { list.push(value); if (list.length > limit) list.splice(0, list.length - limit); };
const activeNm = value => ['REPEAT_MESSAGE', 'NORMAL_OPERATION', 'READY_SLEEP'].includes(value);
const hex = value => `0x${value.toString(16).toUpperCase()}`;

/** One monotonic virtual clock. Each ECU owns boot, diagnostics, storage and calibration. */
export class VehicleSimulator {
  constructor() {
    this.nowMs = 0;
    this.remainder = 0;
    this.selectedId = 'gateway';
    this.events = [];
    this.frames = [];
    this.os = new OsSimulator({ cores: 3 });
    this.ecus = Object.fromEntries(ECU_PROFILES.map(profile => [profile.id, {
      ...profile, boot: new BootSimulator(),
      uds: new UdsSimulator({ testerCanId: profile.requestId, ecuCanId: profile.responseId, asyncEraseMs: 250 }),
      storage: new StorageSimulator(), xcp: new XcpSimulator(),
      powered: profile.id === 'gateway', busOff: false, bootSeen: false, volatileRevision: 0,
      requested: true, nm: 'BUS_SLEEP', nmSince: 0, lastNm: 0, nextNm: 0,
      lastHeartbeat: null, seenPeers: {}, missingPeers: [], supervisionSince: null,
      autoTester: false, nextTester: 2000, pendingWrites: {},
      canFd: false, sensor: 53, filtered: 48, actuator: 0, counter: 0,
      cdd: { enabled: true, fault: false, phase: 'SAFE', dma: [null, null], writeBuffer: 0, published: null, quality: 'INVALID', irqCount: 0 },
    }]));
    for (const ecu of Object.values(this.ecus)) if (!ecu.powered) ecu.storage.powerOff();
  }

  ecu(id = this.selectedId) {
    const ecu = this.ecus[id];
    if (!ecu) throw new RangeError(`Unknown ECU: ${id}`);
    return ecu;
  }
  select(id) { this.ecu(id); this.selectedId = id; }
  event(ecuId, kind, detail) { bound(this.events, { time: this.nowMs, ecuId, kind, detail }); }
  frame(ecu, kind, canId, data, detail, direction = 'TX') {
    bound(this.frames, { time: this.nowMs, ecuId: ecu.id, network: ecu.network, kind, canId: typeof canId === 'number' ? hex(canId) : canId, data: [...data], detail, direction }, 160);
  }
  _resetVolatile(ecu, requested) {
    ecu.volatileRevision += 1;
    ecu.busOff = false;
    ecu.bootSeen = false;
    ecu.requested = requested;
    ecu.nm = 'BUS_SLEEP';
    ecu.nmSince = this.nowMs;
    ecu.lastNm = this.nowMs;
    ecu.nextNm = this.nowMs;
    ecu.lastHeartbeat = null;
    ecu.seenPeers = {};
    ecu.missingPeers = [];
    ecu.supervisionSince = null;
    ecu.autoTester = false;
    ecu.nextTester = this.nowMs + 2000;
    ecu.canFd = false;
    ecu.pendingWrites = {};
    ecu.filtered = 48;
    ecu.actuator = 0;
    ecu.counter = 0;
    ecu.cdd = { enabled: true, fault: false, phase: 'SAFE', dma: [null, null], writeBuffer: 0, published: null, quality: 'INVALID', irqCount: 0 };
    ecu.uds.setTransport({ canFd: false });
  }
  _nm(ecu, next, reason) {
    if (ecu.nm === next) return;
    this.event(ecu.id, 'NM', `${ecu.nm} → ${next} · ${reason}`);
    ecu.nm = next;
    ecu.nmSince = this.nowMs;
  }
  _wake(ecu, reason) {
    ecu.lastNm = this.nowMs;
    ecu.nextNm = this.nowMs;
    ecu.supervisionSince = this.nowMs;
    ecu.seenPeers = {};
    this._nm(ecu, 'REPEAT_MESSAGE', reason);
  }
  start(id = this.selectedId) {
    const ecu = this.ecu(id);
    // Starting an already powered ECU is a reset: volatile/in-flight storage
    // work is discarded, while the committed Fee records remain available.
    if (ecu.powered) ecu.storage.powerOff();
    ecu.powered = true;
    ecu.storage.powerOn();
    this._resetVolatile(ecu, true);
    ecu.boot.seek(42);
    ecu.xcp.reset();
    ecu.uds.reset();
    if (id === 'gateway') this.os.reset();
    this.event(id, 'POWER', '上电并完成本 ECU 启动；恢复已提交的标定和 DTC');
    this._syncBoot(ecu);
  }
  startAll() { for (const ecu of Object.values(this.ecus)) this.start(ecu.id); }
  powerOff(id = this.selectedId) {
    const ecu = this.ecu(id);
    this._nm(ecu, 'BUS_SLEEP', 'ECU 断电');
    ecu.powered = false;
    ecu.storage.powerOff();
    ecu.xcp.reset();
    ecu.uds.reset();
    ecu.boot.reset();
    this._resetVolatile(ecu, false);
    if (id === 'gateway') this.os.reset();
    this.event(id, 'POWER', '断电：取消未提交存储作业，终止诊断与采集');
  }
  resetEcu(id = this.selectedId) { this.powerOff(id); this.start(id); }
  requestNetwork(id, requested) {
    const ecu = this.ecu(id);
    ecu.requested = Boolean(requested);
    if (ecu.powered && ecu.boot.getSnapshot().status === 'running' && requested) {
      if (['BUS_SLEEP', 'PREPARE_BUS_SLEEP'].includes(ecu.nm)) this._wake(ecu, '本地 NetworkRequest');
      else if (ecu.nm === 'READY_SLEEP') this._nm(ecu, 'NORMAL_OPERATION', '重新请求网络');
    }
    this.event(id, 'ComM', requested ? 'NetworkRequest' : 'NetworkRelease');
  }
  wake(id = this.selectedId) {
    const ecu = this.ecu(id);
    if (!ecu.powered) this.start(id);
    if (ecu.boot.getSnapshot().status === 'running') this._wake(ecu, 'KL15 / 网络唤醒');
  }
  setBusOff(id, enabled) {
    const ecu = this.ecu(id); ecu.busOff = Boolean(enabled);
    ecu.boot.setBusOff(ecu.busOff);
    if (ecu.busOff) ecu.xcp.disconnect();
    else if (ecu.powered && ecu.bootSeen) this._wake(ecu, 'Bus-Off 恢复');
    this.event(id, 'CAN', enabled ? 'Bus-Off：链路不可用' : '控制器恢复');
  }
  setCanFd(enabled, id = this.selectedId) {
    const ecu = this.ecu(id); ecu.canFd = Boolean(enabled); ecu.uds.setTransport({ canFd: ecu.canFd });
  }
  setSensor(value, id = this.selectedId) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new RangeError('传感器值范围为 0–100');
    this.ecu(id).sensor = value;
  }
  setCddFault(value, id = this.selectedId) {
    const ecu = this.ecu(id); ecu.cdd.fault = Boolean(value);
    if (value) { ecu.cdd.quality = 'INVALID'; ecu.cdd.published = null; }
    this._report(ecu, 0xa10202, value ? 0x09 : 0x08, 'CDD 角度采集 CRC 故障');
  }
  _syncBoot(ecu) {
    const boot = ecu.boot.getSnapshot();
    if (boot.status !== 'running') { ecu.bootSeen = false; return false; }
    if (!ecu.bootSeen && ecu.powered) {
      // Restore startup-owned values once, regardless of which view first
      // observes RUN. Later NetworkRelease/calibration changes belong to runtime.
      const params = Object.fromEntries(['gain', 'filter', 'threshold'].map(name => [name, ecu.storage.readBlock(name)]));
      ecu.xcp.loadCalibration(params);
      const storedDtcs = ecu.storage.readBlock('dtcs');
      if (Array.isArray(storedDtcs)) for (const dtc of storedDtcs) ecu.uds.reportDtc(dtc.id, dtc.status, dtc.label);
      ecu.requested = boot.comm.requested === 'FULL_COM';
      if (boot.can.state === 'BUS_OFF') ecu.busOff = true;
      ecu.bootSeen = true;
      this._wake(ecu, 'EcuM / BswM 启动放行');
    }
    return ecu.powered;
  }
  diagnosticState(id = this.selectedId) {
    const ecu = this.ecu(id);
    this._syncBoot(ecu);
    const state = ecu.boot.getSnapshot();
    const gateway = this.ecu('gateway');
    const route = id === 'gateway' || (gateway.powered && gateway.boot.getSnapshot().status === 'running' && !gateway.busOff && activeNm(gateway.nm));
    if (!ecu.powered) state.modules.dcm = 'uninit';
    if (!ecu.powered || ecu.busOff || !activeNm(ecu.nm) || !route) {
      state.can = { ...state.can, actual: ecu.busOff ? 'SILENT_COM' : 'NO_COM', state: ecu.busOff ? 'BUS_OFF' : 'OFFLINE', txEnabled: false };
    } else {
      // The vehicle-level controller state is authoritative after startup. It
      // can recover a BootSimulator that originally demonstrated Bus-Off.
      state.can = { ...state.can, requested: 'FULL_COM', actual: 'FULL_COM', state: 'ONLINE', txEnabled: true };
    }
    return state;
  }
  available(id = this.selectedId) {
    const state = this.diagnosticState(id);
    return ['ready', 'active'].includes(state.modules.dcm) && state.can.actual === 'FULL_COM' && state.can.txEnabled;
  }
  request(input, id = this.selectedId) {
    const ecu = this.ecu(id);
    const bytes = parseHexRequest(input);
    const result = ecu.uds.request(bytes, this.diagnosticState(id));
    this._recordDiagnostic(ecu, result);
    if (result.positive && bytes[0] === 0x14) this._queuePersistent(ecu, 'dtcs', ecu.uds.getSnapshot().dtcs, 'ClearDiagnosticInformation');
    if (result.positive && bytes[0] === 0x11) {
      // The UDS model preserves active image metadata; the ECU lifecycle clears
      // all volatile state and reloads only committed NvM blocks.
      this.resetEcu(id);
    }
    return result;
  }
  _recordDiagnostic(ecu, result) {
    for (const frame of result.frames) this.frame(ecu, 'UDS', frame.canId, frame.data, `${frame.type} · ${result.service}`, frame.direction);
    this.event(ecu.id, 'UDS', `${result.requestHex} → ${result.responseHex || '无响应'} · ${result.summary}`);
  }
  _report(ecu, id, status, label) {
    ecu.uds.reportDtc(id, status, label);
    const persistence = this._queuePersistent(ecu, 'dtcs', ecu.uds.getSnapshot().dtcs, `Dem ${hex(id)}`);
    this.event(ecu.id, 'Dem', `${hex(id)} status=${hex(status)} · ${label}，${persistence.accepted ? 'NvM 已接受，尚待耐久提交' : 'NvM 当前拒绝，已保留待重试'}`);
    return persistence;
  }
  _lastStorageRequest(ecu, name) {
    return ecu.storage.queue.findLast(job => job.name === name)
      ?? (ecu.storage.activeJob?.name === name ? ecu.storage.activeJob : null);
  }
  _attemptPersistent(ecu, name) {
    const entry = ecu.pendingWrites[name];
    if (!entry) return { name, accepted: true, durable: true, pending: false };
    const outstanding = this._lastStorageRequest(ecu, name);
    if (!outstanding && sameValue(ecu.storage.readBlock(name), entry.value)) {
      delete ecu.pendingWrites[name];
      this.event(ecu.id, 'NvM', `${name} 已完成耐久提交`);
      return { name, accepted: true, durable: true, pending: false };
    }
    if (outstanding && sameValue(outstanding.value, entry.value)) {
      entry.accepted = true;
      return { name, accepted: true, durable: false, pending: true };
    }
    if (entry.lastAttempt !== null && this.nowMs - entry.lastAttempt < 50) {
      return { name, accepted: false, durable: false, pending: true };
    }
    entry.attempts += 1;
    entry.lastAttempt = this.nowMs;
    const accepted = ecu.storage.writeBlock(name, entry.value);
    entry.accepted ||= accepted;
    return { name, accepted, durable: false, pending: true };
  }
  _queuePersistent(ecu, name, value, source) {
    const previous = ecu.pendingWrites[name];
    ecu.pendingWrites[name] = {
      name,
      value: clone(value),
      source,
      attempts: previous?.attempts ?? 0,
      accepted: previous?.accepted ?? false,
      lastAttempt: previous?.lastAttempt ?? null,
    };
    return this._attemptPersistent(ecu, name);
  }
  _retryPersistence(ecu) {
    for (const name of Object.keys(ecu.pendingWrites)) this._attemptPersistent(ecu, name);
  }
  connectXcp() { if (!this.available()) throw new Error('目标 ECU 或网关链路不可用'); this.ecu().xcp.connect(); }
  calibrate(name, value) { if (!this.available()) throw new Error('目标 ECU 或网关链路不可用'); this.ecu().xcp.calibrate(name, value); }
  saveCalibration() {
    const ecu = this.ecu();
    if (!this.available()) throw new Error('目标 ECU 或网关链路不可用');
    const blocks = Object.entries(ecu.xcp.getSnapshot().parameters)
      .map(([name, value]) => this._queuePersistent(ecu, name, value, 'XCP Store Calibration'));
    const result = {
      accepted: blocks.every(block => block.accepted),
      durable: blocks.every(block => block.durable),
      pending: blocks.some(block => block.pending),
      blocks,
    };
    this.event(ecu.id, 'XCP', result.durable
      ? 'RAM 标定与已提交 NvM 一致'
      : result.accepted ? 'RAM 标定已由 NvM 接受；等待耐久提交后才能掉电保留' : 'NvM 暂未接受全部标定；已保留合并后的待重试值');
    return clone(result);
  }
  tick(ms) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) throw new RangeError('单次推进范围为 0–60000 ms');
    this.remainder += ms;
    // All external events resolve on a 10 ms teaching clock; fractional input is retained.
    while (this.remainder >= 10) { this.remainder -= 10; this.nowMs += 10; this._tickOne(); }
    return this.getSnapshot();
  }
  _tickOne() {
    const list = Object.values(this.ecus);
    for (const ecu of list) {
      if (!this._syncBoot(ecu)) continue;
      ecu.storage.tick(10);
      this._retryPersistence(ecu);
      const before = ecu.uds.getSnapshot().latest?.id;
      if (ecu.autoTester && this.nowMs >= ecu.nextTester && this.available(ecu.id)) {
        this.request('3E 80', ecu.id); ecu.nextTester = this.nowMs + 2000;
      }
      ecu.uds.tick(10);
      const latest = ecu.uds.getSnapshot().latest;
      if (latest && latest.id !== before && latest.request?.[0] === 0x31) this._recordDiagnostic(ecu, latest);
      if (ecu.busOff) continue;
      if (ecu.nm === 'REPEAT_MESSAGE' && this.nowMs - ecu.nmSince >= NM_TIMING.repeat) this._nm(ecu, ecu.requested ? 'NORMAL_OPERATION' : 'READY_SLEEP', 'RepeatMessageTime 到期');
      if (ecu.nm === 'NORMAL_OPERATION' && !ecu.requested) this._nm(ecu, 'READY_SLEEP', '本地请求已释放');
      if (ecu.nm === 'READY_SLEEP' && this.nowMs - ecu.lastNm >= NM_TIMING.timeout) this._nm(ecu, 'PREPARE_BUS_SLEEP', 'NmTimeoutTime 到期');
      if (ecu.nm === 'PREPARE_BUS_SLEEP' && this.nowMs - ecu.nmSince >= NM_TIMING.waitSleep) {
        this._nm(ecu, 'BUS_SLEEP', 'WaitBusSleepTime 到期'); ecu.xcp.disconnect();
      }
      if (['REPEAT_MESSAGE', 'NORMAL_OPERATION'].includes(ecu.nm) && this.nowMs >= ecu.nextNm) {
        ecu.nextNm = this.nowMs + NM_TIMING.cycle;
        ecu.lastNm = this.nowMs;
        // Teaching PDU layout: node ID byte 0, CBV byte 1; no RMR unless explicitly requested.
        this.frame(ecu, 'NM', 0x500 + ecu.node, [ecu.node, 0, 0, 0, 0, 0, 0, 0], 'Byte0 节点 ID · Byte1 CBV=00 · Byte2–7 用户数据');
        for (const peer of list) if (peer !== ecu && peer.powered && peer.bootSeen && !peer.busOff && this._shareNetwork(ecu, peer)) {
          peer.lastNm = this.nowMs;
          if (['BUS_SLEEP', 'PREPARE_BUS_SLEEP'].includes(peer.nm)) this._wake(peer, `${ecu.name} NM 接收唤醒`);
        }
      }
      if (activeNm(ecu.nm) && this.nowMs % 10 === 0) this._sample(ecu);
      if (activeNm(ecu.nm)) {
        ecu.xcp.tick(10, { sensor: ecu.sensor, filtered: ecu.filtered, actuator: ecu.actuator });
        if (!this.available(ecu.id)) ecu.xcp.disconnect();
        for (const peer of list) {
          const seen = ecu.seenPeers[peer.id];
          const supervisionStart = seen ?? ecu.supervisionSince;
          if (peer === ecu || !this._shareNetwork(ecu, peer) || supervisionStart === null || !ecu.requested
            || this.nowMs - supervisionStart <= NM_TIMING.heartbeatTimeout || ecu.missingPeers.includes(peer.id)) continue;
          ecu.missingPeers.push(peer.id);
          this._report(ecu, 0xc10000 + peer.node, 0x09, `${peer.name} 周期报文超时`);
        }
      }
    }
    const gateway = this.ecu('gateway');
    if (gateway.powered && gateway.bootSeen && activeNm(gateway.nm)) this.os.tick(10);
  }
  _shareNetwork(a, b) { return a.id === 'gateway' || b.id === 'gateway' || a.network === b.network; }
  _sample(ecu) {
    const cdd = ecu.cdd;
    cdd.irqCount += 1;
    cdd.phase = cdd.fault ? 'CRC_ERROR' : 'DMA → IRQ → SchM → RTE';
    cdd.dma[cdd.writeBuffer] = ecu.sensor;
    if (!cdd.fault) { cdd.published = cdd.dma[cdd.writeBuffer]; cdd.quality = 'VALID'; }
    else { cdd.published = null; cdd.quality = 'INVALID'; }
    cdd.writeBuffer = 1 - cdd.writeBuffer;
    const p = ecu.xcp.getSnapshot().parameters;
    if (cdd.quality === 'VALID') {
      ecu.filtered += (cdd.published - ecu.filtered) * p.filter;
      ecu.actuator = Math.max(0, Math.min(100, (ecu.filtered - p.threshold) * p.gain));
    } else ecu.actuator = 0;
    ecu.counter = (ecu.counter + 1) & 255;
    ecu.lastHeartbeat = this.nowMs;
    this.frame(ecu, 'APP', ecu.appId, [ecu.counter, Math.round(ecu.actuator), Math.round(ecu.filtered), Math.round(ecu.sensor)], 'Byte0 AliveCounter · Byte1 Actuator · Byte2 Filtered · Byte3 Sensor');
    for (const observer of Object.values(this.ecus)) if (observer !== ecu && observer.powered && !observer.busOff && activeNm(observer.nm) && this._shareNetwork(ecu, observer)) {
      observer.seenPeers[ecu.id] = this.nowMs;
      if (observer.missingPeers.includes(ecu.id)) {
        observer.missingPeers = observer.missingPeers.filter(id => id !== ecu.id);
        this._report(observer, 0xc10000 + ecu.node, 0x08, `${ecu.name} 周期报文已恢复`);
      }
    }
  }
  getSnapshot() {
    return clone({ nowMs: this.nowMs, selectedId: this.selectedId,
      ecus: Object.values(this.ecus).map(ecu => ({ id: ecu.id, name: ecu.name, network: ecu.network, powered: ecu.powered, busOff: ecu.busOff,
        bootStatus: ecu.boot.getSnapshot().status, requested: ecu.requested, nm: ecu.nm, canFd: ecu.canFd,
        repeatRemaining: Math.max(0, NM_TIMING.repeat - (this.nowMs - ecu.nmSince)),
        timeoutRemaining: Math.max(0, NM_TIMING.timeout - (this.nowMs - ecu.lastNm)),
        waitRemaining: Math.max(0, NM_TIMING.waitSleep - (this.nowMs - ecu.nmSince)),
        lastHeartbeat: ecu.lastHeartbeat, missingPeers: ecu.missingPeers, session: ecu.uds.getSnapshot().session, security: ecu.uds.getSnapshot().security,
        dtcCount: ecu.uds.getSnapshot().dtcCount, sensor: ecu.sensor, filtered: ecu.filtered, actuator: ecu.actuator, cdd: ecu.cdd,
        pendingWrites: ecu.pendingWrites,
      })), frames: this.frames, events: this.events,
    });
  }
}
