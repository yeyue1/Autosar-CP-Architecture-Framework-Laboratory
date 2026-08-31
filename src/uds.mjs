const HISTORY_LIMIT = 40;
const TESTER_CAN_ID = 0x7e0;
const ECU_CAN_ID = 0x7e8;

export const UDS_SESSIONS = Object.freeze({
  0x01: { id: 0x01, key: 'default', label: '默认会话' },
  0x02: { id: 0x02, key: 'programming', label: '编程会话' },
  0x03: { id: 0x03, key: 'extended', label: '扩展会话' },
});

export const UDS_NRC = Object.freeze({
  0x11: 'ServiceNotSupported',
  0x12: 'SubFunctionNotSupported',
  0x13: 'IncorrectMessageLengthOrInvalidFormat',
  0x24: 'RequestSequenceError',
  0x22: 'ConditionsNotCorrect',
  0x31: 'RequestOutOfRange',
  0x33: 'SecurityAccessDenied',
  0x35: 'InvalidKey',
  0x36: 'ExceededNumberOfAttempts',
  0x37: 'RequiredTimeDelayNotExpired',
  0x70: 'UploadDownloadNotAccepted',
  0x71: 'TransferDataSuspended',
  0x72: 'GeneralProgrammingFailure',
  0x73: 'WrongBlockSequenceCounter',
  0x78: 'ResponsePending',
  0x7e: 'SubFunctionNotSupportedInActiveSession',
});

export const UDS_SERVICES = Object.freeze([
  { sid: 0x10, group: 'diagnostic', name: 'DiagnosticSessionControl', label: '会话控制', sample: '10 03', note: '切换默认、编程或扩展会话。' },
  { sid: 0x22, group: 'diagnostic', name: 'ReadDataByIdentifier', label: '读取 DID', sample: '22 F1 90', note: '读取示例 VIN，并观察多帧响应。' },
  { sid: 0x27, group: 'diagnostic', name: 'SecurityAccess', label: '安全访问', sample: '27 01', note: '先请求 Seed，再发送教学 Key。' },
  { sid: 0x19, group: 'diagnostic', name: 'ReadDTCInformation', label: '读取 DTC', sample: '19 02 FF', note: '按状态掩码读取故障记录。' },
  { sid: 0x14, group: 'diagnostic', name: 'ClearDiagnosticInformation', label: '清除 DTC', sample: '14 FF FF FF', note: '需要扩展会话与安全解锁。' },
  { sid: 0x2e, group: 'diagnostic', name: 'WriteDataByIdentifier', label: '写入 DID', sample: '2E F1 A0 12 34 56 78', note: '写入示例维修站代码。' },
  { sid: 0x31, group: 'diagnostic', name: 'RoutineControl', label: '例程控制', sample: '31 01 02 03', note: '启动项目配置的例程。' },
  { sid: 0x3e, group: 'diagnostic', name: 'TesterPresent', label: '保持会话', sample: '3E 00', note: '刷新诊断会话的 S3 计时概念。' },
  { sid: 0x34, group: 'flash', name: 'RequestDownload', label: '请求下载', sample: '34 00 44 00 00 80 00 00 00 00 30', note: '声明目标地址和镜像长度。' },
  { sid: 0x36, group: 'flash', name: 'TransferData', label: '传输数据', sample: '36 01 41 53 4C 46', note: '按块序号传输镜像数据。' },
  { sid: 0x37, group: 'flash', name: 'RequestTransferExit', label: '结束传输', sample: '37', note: '结束本次下载事务。' },
  { sid: 0xb0, group: 'private', name: 'OEMReadBootInfo', label: 'OEM 启动信息', sample: 'B0 01', note: '虚构服务：读取活动分区与版本。' },
  { sid: 0xb1, group: 'private', name: 'OEMReadLiveData', label: 'OEM 实时量', sample: 'B1 01', note: '虚构服务：读取教学电压与温度。' },
  { sid: 0xb2, group: 'private', name: 'OEMFeatureControl', label: 'OEM 特性控制', sample: 'B2 A5 01 01', note: '虚构服务：带项目令牌和访问权限。' },
]);

const SERVICE_BY_ID = new Map(UDS_SERVICES.map((service) => [service.sid, service]));
const clone = (value) => structuredClone(value);
const byte = (value) => Number(value) & 0xff;
const hexByte = (value) => byte(value).toString(16).toUpperCase().padStart(2, '0');
const hexId = (value) => `0x${Number(value).toString(16).toUpperCase()}`;
const ascii = (value) => [...new TextEncoder().encode(value)];

const uint32Bytes = (value) => [
  (Number(value) >>> 24) & 0xff,
  (Number(value) >>> 16) & 0xff,
  (Number(value) >>> 8) & 0xff,
  Number(value) & 0xff,
];

const readUint32 = (bytes, offset = 0) => (
  (((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
);

export function crc32(input) {
  const bytes = parseHexRequest(input);
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function firmwareBytes(label, length, seed) {
  const header = ascii(label).slice(0, Math.min(length, 16));
  return [...header, ...Array.from({ length: Math.max(0, length - header.length) }, (_, index) => (seed + index * 29 + (index >>> 1)) & 0xff)];
}

const FLASH_PROFILE_DATA = [
  { id: 'application-v120', label: 'Application v1.2.0', version: 'ASL-UDS-1.2.0', address: 0x00008000, bytes: firmwareBytes('ASLF|APP|1.2.0', 48, 0x31) },
  { id: 'calibration-2026', label: 'Calibration 2026.08', version: 'CAL-2026.08', address: 0x00009000, bytes: firmwareBytes('ASLF|CAL|2608', 32, 0x6d) },
];

export const UDS_FLASH_PROFILES = Object.freeze(FLASH_PROFILE_DATA.map((profile) => Object.freeze({
  ...profile,
  bytes: Object.freeze([...profile.bytes]),
  checksum: crc32(profile.bytes),
})));

export function buildFlashRequestPlan(profileId, blockPayloadSize = 12) {
  const profile = UDS_FLASH_PROFILES.find((item) => item.id === profileId);
  if (!profile) throw new RangeError(`Unknown teaching firmware profile: ${profileId}`);
  if (!Number.isInteger(blockPayloadSize) || blockPayloadSize < 1 || blockPayloadSize > 14) {
    throw new RangeError('TransferData block payload must contain 1 to 14 bytes.');
  }
  const requests = [
    { stage: 'erase', label: '擦除非活动分区', request: [0x31, 0x01, 0xff, 0x00] },
    { stage: 'download', label: '声明下载地址与长度', request: [0x34, 0x00, 0x44, ...uint32Bytes(profile.address), ...uint32Bytes(profile.bytes.length)] },
  ];
  let block = 1;
  for (let offset = 0; offset < profile.bytes.length; offset += blockPayloadSize) {
    requests.push({
      stage: 'transfer',
      label: `传输数据块 ${block}`,
      request: [0x36, block & 0xff, ...profile.bytes.slice(offset, offset + blockPayloadSize)],
    });
    block = (block + 1) & 0xff;
  }
  requests.push(
    { stage: 'exit', label: '结束下载传输', request: [0x37] },
    { stage: 'verify', label: '校验镜像 CRC32', request: [0x31, 0x01, 0xff, 0x01, ...uint32Bytes(profile.checksum)] },
    { stage: 'activate', label: '激活非活动分区', request: [0x31, 0x01, 0xff, 0x02] },
  );
  return { profile, requests };
}

export function formatHex(bytes) {
  return bytes.map(hexByte).join(' ');
}

export function parseHexRequest(input) {
  if (Array.isArray(input)) {
    if (input.length === 0 || input.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff)) {
      throw new RangeError('UDS request must contain bytes from 00 to FF.');
    }
    return [...input];
  }

  const tokens = String(input ?? '').trim().split(/[\s,;:-]+/).filter(Boolean);
  if (tokens.length === 0) throw new RangeError('请输入至少一个 UDS 字节。');
  return tokens.map((token) => {
    const normalized = token.replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,2}$/i.test(normalized)) throw new RangeError(`无法解析十六进制字节：${token}`);
    return Number.parseInt(normalized, 16);
  });
}

export function deriveTeachingKey(seedBytes) {
  const seed = parseHexRequest(seedBytes);
  if (seed.length !== 4) throw new RangeError('Teaching seed must contain four bytes.');
  const word = (((seed[0] << 24) >>> 0) | (seed[1] << 16) | (seed[2] << 8) | seed[3]) >>> 0;
  const rotated = ((word << 3) | (word >>> 29)) >>> 0;
  const key = (rotated ^ 0xa5c35a7e) >>> 0;
  return [(key >>> 24) & 0xff, (key >>> 16) & 0xff, (key >>> 8) & 0xff, key & 0xff];
}

function padFrame(bytes) {
  return [...bytes, ...Array(Math.max(0, 8 - bytes.length)).fill(0)].slice(0, 8);
}

function payloadFrames(payload, { senderId, receiverId, direction, phase }) {
  if (payload.length <= 7) {
    return [{
      phase,
      type: 'SF',
      owner: direction === 'TX' ? 'Tester' : 'ECU',
      direction,
      canId: hexId(senderId),
      data: padFrame([payload.length, ...payload]),
      payloadLength: payload.length,
    }];
  }

  const frames = [{
    phase,
    type: 'FF',
    owner: direction === 'TX' ? 'Tester' : 'ECU',
    direction,
    canId: hexId(senderId),
    data: padFrame([0x10 | ((payload.length >>> 8) & 0x0f), payload.length & 0xff, ...payload.slice(0, 6)]),
    payloadLength: payload.length,
  }];
  frames.push({
    phase: 'FLOW_CONTROL',
    type: 'FC',
    owner: direction === 'TX' ? 'ECU' : 'Tester',
    direction: direction === 'TX' ? 'RX' : 'TX',
    canId: hexId(receiverId),
    data: [0x30, 0x00, 0x00, 0, 0, 0, 0, 0],
    payloadLength: 0,
  });

  let sequence = 1;
  for (let offset = 6; offset < payload.length; offset += 7) {
    frames.push({
      phase,
      type: 'CF',
      owner: direction === 'TX' ? 'Tester' : 'ECU',
      direction,
      canId: hexId(senderId),
      data: padFrame([0x20 | (sequence & 0x0f), ...payload.slice(offset, offset + 7)]),
      payloadLength: Math.min(7, payload.length - offset),
      sequence,
    });
    sequence = (sequence + 1) & 0x0f;
  }
  return frames;
}

export function buildIsoTpExchange(request, response = []) {
  return [
    ...payloadFrames(request, {
      senderId: TESTER_CAN_ID,
      receiverId: ECU_CAN_ID,
      direction: 'TX',
      phase: 'REQUEST',
    }),
    ...(response.length > 0 ? payloadFrames(response, {
      senderId: ECU_CAN_ID,
      receiverId: TESTER_CAN_ID,
      direction: 'RX',
      phase: 'RESPONSE',
    }) : []),
  ];
}

function createDtcs() {
  return [
    { id: 0x123456, status: 0x2f, label: '供电电压曾低于阈值', origin: 'PRIMARY_MEMORY' },
    { id: 0xc10087, status: 0x28, label: 'CAN 通信信号缺失', origin: 'PRIMARY_MEMORY' },
    { id: 0xa10202, status: 0x09, label: '传感器信号间歇异常', origin: 'PRIMARY_MEMORY' },
  ];
}

function createFlashState({ activeBank = 'A', activeVersion = 'ASL-UDS-1.1' } = {}) {
  return {
    activeBank,
    inactiveBank: activeBank === 'A' ? 'B' : 'A',
    activeVersion,
    targetVersion: null,
    status: 'idle',
    address: null,
    expectedSize: 0,
    receivedSize: 0,
    nextBlockSequenceCounter: 1,
    buffer: [],
    actualChecksum: null,
    expectedChecksum: null,
    verified: false,
    erased: false,
    progress: 0,
  };
}

function createPrivateState() {
  return {
    featureFlags: { 0x01: 0x00, 0x02: 0x01 },
    requestCount: 0,
    lastCommand: null,
  };
}

function serviceName(sid) {
  return SERVICE_BY_ID.get(sid)?.name ?? `UnknownService_${hexByte(sid)}`;
}

function sessionAllowed(session, allowed) {
  return allowed.includes(session);
}

function nrcResult(sid, nrc, explanation) {
  return {
    response: [0x7f, sid, nrc],
    positive: false,
    nrc,
    nrcName: UDS_NRC[nrc] ?? 'UnknownNRC',
    summary: `负响应 NRC ${hexByte(nrc)} · ${UDS_NRC[nrc] ?? 'UnknownNRC'}`,
    explanation,
  };
}

function positiveResult(response, summary, explanation, extra = {}) {
  return { response, positive: true, nrc: null, nrcName: null, summary, explanation, ...extra };
}

export class UdsSimulator {
  constructor() {
    this.reset();
  }

  reset() {
    this._sequence = 0;
    this._seedCounter = 0;
    this._state = {
      session: 'default',
      sessionId: 0x01,
      security: 'locked',
      invalidKeyAttempts: 0,
      pendingSeed: null,
      s3RefreshCount: 0,
      dtcs: createDtcs(),
      workshopCode: [0x00, 0x00, 0x00, 0x00],
      flash: createFlashState(),
      privateProtocol: createPrivateState(),
      latest: null,
      history: [],
    };
    return this.getSnapshot();
  }

  getSnapshot() {
    return clone({
      ...this._state,
      dtcCount: this._state.dtcs.filter((dtc) => dtc.status !== 0).length,
      transactionCount: this._state.history.length,
    });
  }

  request(input, ecuState = {}) {
    const request = parseHexRequest(input);
    const sid = request[0];
    const before = { session: this._state.session, security: this._state.security };
    const transport = this._transportAvailability(ecuState);

    if (!transport.available) {
      return this._record({
        request,
        response: [],
        service: serviceName(sid),
        positive: false,
        nrc: null,
        nrcName: null,
        outcome: 'transport-error',
        summary: transport.reason,
        explanation: transport.explanation,
        frames: [],
        before,
      });
    }

    const result = this._dispatch(request);
    const suppressed = result.suppressed === true;
    const frames = buildIsoTpExchange(request, suppressed ? [] : result.response);
    return this._record({
      request,
      response: suppressed ? [] : result.response,
      service: serviceName(sid),
      outcome: suppressed ? 'suppressed-positive-response' : result.positive ? 'positive' : 'negative',
      frames,
      before,
      ...result,
      response: suppressed ? [] : result.response,
    });
  }

  _transportAvailability(ecuState) {
    const dcmStatus = ecuState.modules?.dcm;
    if (!['ready', 'active'].includes(dcmStatus)) {
      return {
        available: false,
        reason: 'DCM 尚未初始化',
        explanation: '先沿启动流程到第 28 步以后；本实验建议直接运行到 RUN。此时诊断请求不会抵达 UDS 服务层。',
      };
    }
    if (ecuState.can?.actual !== 'FULL_COM' || ecuState.can?.txEnabled !== true) {
      return {
        available: false,
        reason: '诊断 CAN 链路不可用',
        explanation: `当前 CAN actual=${ecuState.can?.actual ?? 'UNAVAILABLE'}。这属于传输失败，不是 ECU 返回的 UDS NRC。`,
      };
    }
    return { available: true };
  }

  _dispatch(request) {
    const sid = request[0];
    switch (sid) {
      case 0x10: return this._diagnosticSessionControl(request);
      case 0x11: return this._ecuReset(request);
      case 0x14: return this._clearDiagnosticInformation(request);
      case 0x19: return this._readDtcInformation(request);
      case 0x22: return this._readDataByIdentifier(request);
      case 0x27: return this._securityAccess(request);
      case 0x2e: return this._writeDataByIdentifier(request);
      case 0x31: return this._routineControl(request);
      case 0x34: return this._requestDownload(request);
      case 0x36: return this._transferData(request);
      case 0x37: return this._requestTransferExit(request);
      case 0x3e: return this._testerPresent(request);
      case 0xb0: return this._oemReadBootInfo(request);
      case 0xb1: return this._oemReadLiveData(request);
      case 0xb2: return this._oemFeatureControl(request);
      default:
        return nrcResult(sid, 0x11, '当前教学 DCM 配置没有启用该服务。服务是否可用取决于 DcmDsdServiceTable 配置。');
    }
  }

  _diagnosticSessionControl(request) {
    if (request.length !== 2) return nrcResult(0x10, 0x13, '0x10 在本实验中需要一个 sub-function 字节。');
    const subFunction = request[1] & 0x7f;
    const session = UDS_SESSIONS[subFunction];
    if (!session) return nrcResult(0x10, 0x12, '只配置了 default(01)、programming(02) 和 extended(03)。');
    this._state.session = session.key;
    this._state.sessionId = session.id;
    this._state.security = 'locked';
    this._state.pendingSeed = null;
    this._state.invalidKeyAttempts = 0;
    this._state.flash = createFlashState({
      activeBank: this._state.flash.activeBank,
      activeVersion: this._state.flash.activeVersion,
    });
    return positiveResult(
      [0x50, subFunction, 0x00, 0x32, 0x01, 0xf4],
      `已进入${session.label}`,
      '正响应 SID=请求 SID+0x40；附带的 P2/P2* 数值是教学配置，不代表真实 ECU 标定。',
    );
  }

  _ecuReset(request) {
    if (request.length !== 2) return nrcResult(0x11, 0x13, '0x11 需要一个复位类型 sub-function。');
    if (!sessionAllowed(this._state.session, ['extended', 'programming'])) {
      return nrcResult(0x11, 0x7e, '本教学配置只在扩展或编程会话中允许 ECUReset。');
    }
    if (this._state.security !== 'unlocked') return nrcResult(0x11, 0x33, '复位动作受安全级别保护。');
    const subFunction = request[1] & 0x7f;
    if (![0x01, 0x03].includes(subFunction)) return nrcResult(0x11, 0x12, '只演示 hardReset(01) 与 softReset(03)。');
    const result = positiveResult([0x51, subFunction], 'ECUReset 已接受', '正响应发送后，教学诊断状态回到默认会话并重新上锁。');
    this._state.session = 'default';
    this._state.sessionId = 0x01;
    this._state.security = 'locked';
    this._state.pendingSeed = null;
    this._state.flash = createFlashState({
      activeBank: this._state.flash.activeBank,
      activeVersion: this._state.flash.activeVersion,
    });
    return result;
  }

  _readDataByIdentifier(request) {
    if (request.length < 3 || (request.length - 1) % 2 !== 0) {
      return nrcResult(0x22, 0x13, '0x22 后应跟一个或多个两字节 DID。');
    }
    const payload = [0x62];
    const names = [];
    for (let index = 1; index < request.length; index += 2) {
      const did = (request[index] << 8) | request[index + 1];
      let value;
      let name;
      if (did === 0xf190) { value = ascii('LDC613P23R1000421'); name = 'VIN'; }
      else if (did === 0xf187) { value = ascii(this._state.flash.activeVersion); name = '软件版本'; }
      else if (did === 0xf186) { value = [this._state.sessionId]; name = '当前诊断会话'; }
      else if (did === 0xf1a0) { value = [...this._state.workshopCode]; name = '维修站代码'; }
      else return nrcResult(0x22, 0x31, `DID ${did.toString(16).toUpperCase().padStart(4, '0')} 未在教学配置中定义。`);
      payload.push(request[index], request[index + 1], ...value);
      names.push(name);
    }
    return positiveResult(payload, `读取 ${names.join('、')} 成功`, 'DID 的含义、长度和访问权限由项目 DCM 配置决定；长响应会经 ISO-TP 分帧。');
  }

  _securityAccess(request) {
    if (request.length < 2) return nrcResult(0x27, 0x13, '0x27 缺少 sub-function。');
    if (!sessionAllowed(this._state.session, ['extended', 'programming'])) {
      return nrcResult(0x27, 0x7e, '先通过 10 03 或 10 02 进入允许 SecurityAccess 的会话。');
    }
    if (this._state.security === 'delay') {
      return nrcResult(0x27, 0x37, '错误次数过多；真实 ECU 会按配置等待一段时间。本实验可重置诊断状态后继续。');
    }

    const subFunction = request[1];
    if (subFunction === 0x01) {
      if (request.length !== 2) return nrcResult(0x27, 0x13, '请求 Seed 不携带额外数据。');
      if (this._state.security === 'unlocked') {
        return positiveResult([0x67, 0x01, 0, 0, 0, 0], '安全级别已经解锁', '全零 Seed 在这里表示无需再次发送 Key。');
      }
      const seedWord = (0x12345678 ^ (this._seedCounter * 0x01020304)) >>> 0;
      this._seedCounter += 1;
      this._state.pendingSeed = [(seedWord >>> 24) & 0xff, (seedWord >>> 16) & 0xff, (seedWord >>> 8) & 0xff, seedWord & 0xff];
      return positiveResult([0x67, 0x01, ...this._state.pendingSeed], 'Seed 已返回', '下一步发送 27 02 + Key。页面可自动计算教学 Key；量产算法绝不能使用这里的示例。', { seed: [...this._state.pendingSeed] });
    }

    if (subFunction === 0x02) {
      if (request.length !== 6) return nrcResult(0x27, 0x13, '发送 Key 需要 27 02 加四个 Key 字节。');
      if (!this._state.pendingSeed) return nrcResult(0x27, 0x24, '需要先请求 Seed。');
      const expected = deriveTeachingKey(this._state.pendingSeed);
      const received = request.slice(2);
      this._state.pendingSeed = null;
      if (formatHex(expected) !== formatHex(received)) {
        this._state.invalidKeyAttempts += 1;
        if (this._state.invalidKeyAttempts >= 3) {
          this._state.security = 'delay';
          return nrcResult(0x27, 0x36, '连续三次错误 Key，进入教学延迟状态。');
        }
        return nrcResult(0x27, 0x35, `Key 不匹配；已失败 ${this._state.invalidKeyAttempts}/3 次。`);
      }
      this._state.security = 'unlocked';
      this._state.invalidKeyAttempts = 0;
      return positiveResult([0x67, 0x02], '安全级别已解锁', '这是可观察状态机，不是密码学实现。真实 Seed/Key 算法和密钥必须受保护。');
    }
    return nrcResult(0x27, 0x12, '只演示 level 1 的 requestSeed(01) / sendKey(02)。');
  }

  _readDtcInformation(request) {
    if (request.length !== 3) return nrcResult(0x19, 0x13, '本实验的 0x19 02 需要一个 DTCStatusMask。');
    if (request[1] !== 0x02) return nrcResult(0x19, 0x12, '只实现 reportDTCByStatusMask(02)。');
    const mask = request[2];
    const records = this._state.dtcs.filter((dtc) => dtc.status !== 0 && (dtc.status & mask) !== 0);
    const payload = [0x59, 0x02, 0xff];
    for (const dtc of records) payload.push((dtc.id >>> 16) & 0xff, (dtc.id >>> 8) & 0xff, dtc.id & 0xff, dtc.status);
    return positiveResult(payload, `返回 ${records.length} 条 DTC`, 'DTCStatusAvailabilityMask=FF 仅为教学配置；每条记录由 3 字节 DTC 与 1 字节状态组成。', { dtcs: clone(records) });
  }

  _clearDiagnosticInformation(request) {
    if (request.length !== 4) return nrcResult(0x14, 0x13, '0x14 后需要三字节 groupOfDTC。');
    if (!sessionAllowed(this._state.session, ['extended', 'programming'])) {
      return nrcResult(0x14, 0x7e, '本教学配置只允许在扩展或编程会话清除 DTC。');
    }
    if (this._state.security !== 'unlocked') return nrcResult(0x14, 0x33, '清除诊断信息受安全级别保护。');
    if (request.slice(1).some((value) => value !== 0xff)) return nrcResult(0x14, 0x31, '只配置了 FFFFFF：全部 DTC 组。');
    for (const dtc of this._state.dtcs) dtc.status = 0;
    return positiveResult([0x54], 'DTC 已清除', '真实 ECU 还会涉及 Dem、存储条件和异步完成；本实验立即提交。');
  }

  _writeDataByIdentifier(request) {
    if (request.length < 4) return nrcResult(0x2e, 0x13, '0x2E 需要 DID 与数据。');
    if (!sessionAllowed(this._state.session, ['extended', 'programming'])) {
      return nrcResult(0x2e, 0x7e, '写 DID 不在默认会话开放。');
    }
    if (this._state.security !== 'unlocked') return nrcResult(0x2e, 0x33, '写入动作受安全级别保护。');
    const did = (request[1] << 8) | request[2];
    if (did !== 0xf1a0 || request.length !== 7) return nrcResult(0x2e, 0x31, '只允许写入四字节 DID F1A0（维修站代码）。');
    this._state.workshopCode = request.slice(3);
    return positiveResult([0x6e, 0xf1, 0xa0], '维修站代码已写入', '这是 RAM 中的教学数据；不会修改真实 NVRAM。');
  }

  _routineControl(request) {
    if (request.length < 4) return nrcResult(0x31, 0x13, '例程控制需要 sub-function 与两字节 routineIdentifier。');
    if (this._state.session !== 'programming') return nrcResult(0x31, 0x7e, '示例例程只在编程会话开放。');
    if (this._state.security !== 'unlocked') return nrcResult(0x31, 0x33, '例程受安全级别保护。');
    if (request[1] !== 0x01) return nrcResult(0x31, 0x12, '本实验只演示 startRoutine(01)。');
    const routineId = (request[2] << 8) | request[3];
    if (routineId === 0x0203) {
      if (request.length !== 4) return nrcResult(0x31, 0x13, '应用存储检查例程不携带额外参数。');
      return positiveResult([0x71, 0x01, 0x02, 0x03, 0x00], '应用存储检查通过', '真实长耗时例程可能先返回 NRC 78 ResponsePending；本教学例程同步完成。');
    }
    if (routineId === 0xff00) {
      if (request.length !== 4) return nrcResult(0x31, 0x13, '擦除例程不携带额外参数。');
      this._state.flash = createFlashState({
        activeBank: this._state.flash.activeBank,
        activeVersion: this._state.flash.activeVersion,
      });
      this._state.flash.status = 'erased';
      this._state.flash.erased = true;
      return positiveResult([0x71, 0x01, 0xff, 0x00, 0x00], `非活动分区 ${this._state.flash.inactiveBank} 已擦除`, 'FF00 是本项目虚构的擦除例程 ID；真实地址范围、供电条件和 Flash 驱动行为由项目定义。');
    }
    if (routineId === 0xff01) {
      if (request.length !== 8) return nrcResult(0x31, 0x13, '校验例程需要四字节期望 CRC32。');
      if (this._state.flash.status !== 'transferred') return nrcResult(0x31, 0x24, '需要先完成 RequestDownload、TransferData 和 RequestTransferExit。');
      const expectedChecksum = readUint32(request, 4);
      this._state.flash.expectedChecksum = expectedChecksum;
      if (expectedChecksum !== this._state.flash.actualChecksum) {
        this._state.flash.status = 'failed';
        return nrcResult(0x31, 0x72, `CRC32 不匹配：expected=${expectedChecksum.toString(16).toUpperCase().padStart(8, '0')} actual=${this._state.flash.actualChecksum.toString(16).toUpperCase().padStart(8, '0')}。`);
      }
      this._state.flash.status = 'verified';
      this._state.flash.verified = true;
      this._state.flash.progress = 95;
      return positiveResult([0x71, 0x01, 0xff, 0x01, 0x00], '镜像 CRC32 校验通过', '这里只校验教学 CRC32；真实安全刷写通常还需要签名、信任链、防回滚和安全启动。');
    }
    if (routineId === 0xff02) {
      if (request.length !== 4) return nrcResult(0x31, 0x13, '激活例程不携带额外参数。');
      if (!this._state.flash.verified || this._state.flash.status !== 'verified') return nrcResult(0x31, 0x24, '镜像通过校验后才能激活。');
      const previousBank = this._state.flash.activeBank;
      this._state.flash.activeBank = this._state.flash.inactiveBank;
      this._state.flash.inactiveBank = previousBank;
      this._state.flash.activeVersion = this._state.flash.targetVersion;
      this._state.flash.status = 'activated';
      this._state.flash.progress = 100;
      return positiveResult([0x71, 0x01, 0xff, 0x02, 0x00], `分区 ${this._state.flash.activeBank} 已激活`, '双分区切换只存在于教学状态；没有改写本机文件、真实 Flash 或启动向量。');
    }
    return nrcResult(0x31, 0x31, '只配置例程 0203、FF00（擦除）、FF01（校验）和 FF02（激活）。');
  }

  _requestDownload(request) {
    if (request.length !== 11) return nrcResult(0x34, 0x13, '教学 RequestDownload 使用 DFI + ALFI(44) + 四字节地址 + 四字节长度。');
    if (this._state.session !== 'programming') return nrcResult(0x34, 0x7e, '下载只在编程会话开放。');
    if (this._state.security !== 'unlocked') return nrcResult(0x34, 0x33, '下载操作受安全级别保护。');
    if (!this._state.flash.erased || this._state.flash.status !== 'erased') return nrcResult(0x34, 0x22, '必须先执行 FF00 擦除非活动分区。');
    if (request[1] !== 0x00 || request[2] !== 0x44) return nrcResult(0x34, 0x31, '只支持未压缩/未加密 DFI=00 与 ALFI=44。');
    const address = readUint32(request, 3);
    const size = readUint32(request, 7);
    const profile = UDS_FLASH_PROFILES.find((item) => item.address === address && item.bytes.length === size);
    if (!profile) return nrcResult(0x34, 0x31, `地址 0x${address.toString(16).toUpperCase()} / 长度 ${size} 不属于教学镜像。`);
    Object.assign(this._state.flash, {
      status: 'download-requested', address, expectedSize: size, receivedSize: 0,
      nextBlockSequenceCounter: 1, buffer: [], actualChecksum: null, expectedChecksum: null,
      targetVersion: profile.version, verified: false, progress: 0,
    });
    return positiveResult([0x74, 0x20, 0x00, 0x10], `已接受 ${profile.label} 下载请求`, 'maxNumberOfBlockLength=0x0010，表示本教学配置每个 TransferData 请求总长度最多 16 字节。');
  }

  _transferData(request) {
    if (request.length < 3 || request.length > 16) return nrcResult(0x36, 0x13, 'TransferData 需要块序号和 1–14 字节数据。');
    if (this._state.session !== 'programming') return nrcResult(0x36, 0x7e, '数据传输只在编程会话开放。');
    if (this._state.security !== 'unlocked') return nrcResult(0x36, 0x33, '数据传输受安全级别保护。');
    if (!['download-requested', 'transferring'].includes(this._state.flash.status)) return nrcResult(0x36, 0x24, 'TransferData 前必须成功执行 RequestDownload。');
    const sequence = request[1];
    if (sequence !== this._state.flash.nextBlockSequenceCounter) {
      return nrcResult(0x36, 0x73, `期望块序号 ${hexByte(this._state.flash.nextBlockSequenceCounter)}，收到 ${hexByte(sequence)}。`);
    }
    const payload = request.slice(2);
    if (this._state.flash.receivedSize + payload.length > this._state.flash.expectedSize) {
      this._state.flash.status = 'failed';
      return nrcResult(0x36, 0x71, '数据超过 RequestDownload 声明的镜像长度，传输已暂停。');
    }
    this._state.flash.buffer.push(...payload);
    this._state.flash.receivedSize += payload.length;
    this._state.flash.nextBlockSequenceCounter = (sequence + 1) & 0xff;
    this._state.flash.status = 'transferring';
    this._state.flash.progress = Math.round(this._state.flash.receivedSize / this._state.flash.expectedSize * 80);
    return positiveResult([0x76, sequence], `数据块 ${sequence} 已接收`, `${this._state.flash.receivedSize} / ${this._state.flash.expectedSize} 字节；块序号用于发现丢块、乱序和错误重发。`, { flashProgress: this._state.flash.progress });
  }

  _requestTransferExit(request) {
    if (request.length !== 1) return nrcResult(0x37, 0x13, '本教学配置的 RequestTransferExit 不携带参数。');
    if (this._state.session !== 'programming') return nrcResult(0x37, 0x7e, '结束下载只在编程会话开放。');
    if (this._state.security !== 'unlocked') return nrcResult(0x37, 0x33, '结束下载受安全级别保护。');
    if (this._state.flash.status !== 'transferring' || this._state.flash.receivedSize !== this._state.flash.expectedSize) {
      return nrcResult(0x37, 0x24, `下载尚未完整：${this._state.flash.receivedSize} / ${this._state.flash.expectedSize} 字节。`);
    }
    this._state.flash.actualChecksum = crc32(this._state.flash.buffer);
    this._state.flash.status = 'transferred';
    this._state.flash.progress = 85;
    return positiveResult([0x77], '下载传输已结束', `镜像已暂存，计算得到 CRC32=${this._state.flash.actualChecksum.toString(16).toUpperCase().padStart(8, '0')}；仍需 FF01 校验例程。`);
  }

  _oemReadBootInfo(request) {
    if (request.length !== 2 || request[1] !== 0x01) return nrcResult(0xb0, 0x31, '虚构 OEM B0 只定义 sub-command 01。');
    this._state.privateProtocol.requestCount += 1;
    this._state.privateProtocol.lastCommand = 'B0-01';
    return positiveResult([0xf0, 0x01, this._state.flash.activeBank.charCodeAt(0), ...ascii(this._state.flash.activeVersion)], 'OEM 启动信息已返回', 'B0、响应格式和字段均为本项目虚构示例，不对应任何真实厂商。', { privateProtocol: true });
  }

  _oemReadLiveData(request) {
    if (request.length !== 2 || request[1] !== 0x01) return nrcResult(0xb1, 0x31, '虚构 OEM B1 只定义 sub-command 01。');
    if (!sessionAllowed(this._state.session, ['extended', 'programming'])) return nrcResult(0xb1, 0x7e, 'OEM 实时量只在扩展或编程会话开放。');
    this._state.privateProtocol.requestCount += 1;
    this._state.privateProtocol.lastCommand = 'B1-01';
    return positiveResult([0xf1, 0x01, 0x36, 0xb0, 0x2a], 'OEM 实时量已返回', '示例字段：供电 14000mV、温度 42°C。编码和缩放完全由项目私有定义。', { privateProtocol: true });
  }

  _oemFeatureControl(request) {
    if (request.length !== 4) return nrcResult(0xb2, 0x13, '虚构 OEM B2 格式为 B2 A5 featureId value。');
    if (!sessionAllowed(this._state.session, ['extended', 'programming'])) return nrcResult(0xb2, 0x7e, 'OEM 特性控制只在扩展或编程会话开放。');
    if (this._state.security !== 'unlocked') return nrcResult(0xb2, 0x33, 'OEM 特性控制仍受 DCM 安全状态保护。');
    if (request[1] !== 0xa5) return nrcResult(0xb2, 0x31, '项目令牌不正确；A5 只是公开的教学常量，不是安全密钥。');
    const featureId = request[2];
    const value = request[3];
    if (![0x01, 0x02].includes(featureId) || ![0x00, 0x01].includes(value)) return nrcResult(0xb2, 0x31, '只配置 feature 01/02，值只能是 00/01。');
    this._state.privateProtocol.featureFlags[featureId] = value;
    this._state.privateProtocol.requestCount += 1;
    this._state.privateProtocol.lastCommand = `B2-${hexByte(featureId)}`;
    return positiveResult([0xf2, featureId, value], `OEM 特性 ${hexByte(featureId)} 已设为 ${hexByte(value)}`, '“私有”只表示项目自定义语义，不表示可以绕过会话、安全、长度和范围检查。', { privateProtocol: true });
  }

  _testerPresent(request) {
    if (request.length !== 2) return nrcResult(0x3e, 0x13, 'TesterPresent 需要一个 sub-function。');
    const suppress = (request[1] & 0x80) !== 0;
    if ((request[1] & 0x7f) !== 0x00) return nrcResult(0x3e, 0x12, 'TesterPresent 只支持 zeroSubFunction。');
    this._state.s3RefreshCount += 1;
    return positiveResult(
      [0x7e, 0x00],
      suppress ? 'TesterPresent 已接受，正响应被抑制' : 'TesterPresent 已响应',
      '它用于维持非默认诊断会话；本实验记录刷新次数但不运行真实 S3Server 计时器。',
      { suppressed: suppress },
    );
  }

  _record(transaction) {
    const entry = {
      id: ++this._sequence,
      ...transaction,
      requestHex: formatHex(transaction.request),
      responseHex: formatHex(transaction.response),
      after: { session: this._state.session, security: this._state.security },
    };
    this._state.latest = entry;
    this._state.history.push(entry);
    if (this._state.history.length > HISTORY_LIMIT) this._state.history.splice(0, this._state.history.length - HISTORY_LIMIT);
    return clone(entry);
  }
}
