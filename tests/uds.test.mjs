import test from 'node:test';
import assert from 'node:assert/strict';

import { BootSimulator } from '../src/engine.mjs';
import {
  UdsSimulator,
  UDS_FLASH_PROFILES,
  buildFlashRequestPlan,
  buildIsoTpExchange,
  crc32,
  deriveTeachingKey,
  formatHex,
  parseHexRequest,
} from '../src/uds.mjs';

const normalRun = () => new BootSimulator().seek(42);

function enterProgrammingAndUnlock(uds, ecu) {
  uds.request('10 02', ecu);
  const seed = uds.request('27 01', ecu).response.slice(2);
  return uds.request([0x27, 0x02, ...deriveTeachingKey(seed)], ecu);
}

test('hex request parsing is strict and formatting is stable', () => {
  assert.deepEqual(parseHexRequest('0x22 F1,90'), [0x22, 0xf1, 0x90]);
  assert.deepEqual(parseHexRequest([0x10, 0x03]), [0x10, 0x03]);
  assert.equal(formatHex([0, 15, 255]), '00 0F FF');
  assert.throws(() => parseHexRequest('22 GG'), /无法解析/);
  assert.throws(() => parseHexRequest([]), /bytes/);
});

test('diagnostic requests cannot bypass DCM and transport readiness', () => {
  const uds = new UdsSimulator();
  const off = new BootSimulator().getSnapshot();
  const result = uds.request('22 F1 90', off);
  assert.equal(result.outcome, 'transport-error');
  assert.equal(result.response.length, 0);
  assert.match(result.summary, /DCM/);

  const beforeCan = new BootSimulator().seek(31);
  const noLink = uds.request('22 F1 90', beforeCan);
  assert.equal(noLink.outcome, 'transport-error');
  assert.match(noLink.summary, /CAN/);
});

test('ReadDataByIdentifier returns a VIN over ISO-TP multi-frame response', () => {
  const uds = new UdsSimulator();
  const result = uds.request('22 F1 90', normalRun());
  assert.equal(result.positive, true);
  assert.deepEqual(result.response.slice(0, 3), [0x62, 0xf1, 0x90]);
  assert.ok(result.response.length > 7);
  assert.equal(result.frames[0].type, 'SF');
  assert.ok(result.frames.some((frame) => frame.type === 'FF'));
  assert.ok(result.frames.some((frame) => frame.type === 'FC'));
  assert.ok(result.frames.some((frame) => frame.type === 'CF'));
  assert.equal(new TextDecoder().decode(Uint8Array.from(result.response.slice(3))), 'LDC613P23R1000421');
});

test('session control and SecurityAccess implement the seed-key sequence', () => {
  const uds = new UdsSimulator();
  const ecu = normalRun();
  assert.deepEqual(uds.request('10 03', ecu).response.slice(0, 2), [0x50, 0x03]);
  const seedResult = uds.request('27 01', ecu);
  const seed = seedResult.response.slice(2);
  assert.equal(seed.length, 4);
  const key = deriveTeachingKey(seed);
  const unlock = uds.request([0x27, 0x02, ...key], ecu);
  assert.equal(unlock.positive, true);
  assert.equal(uds.getSnapshot().security, 'unlocked');
});

test('SecurityAccess rejects wrong keys and enters delay after three failures', () => {
  const uds = new UdsSimulator();
  const ecu = normalRun();
  uds.request('10 03', ecu);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    uds.request('27 01', ecu);
    const result = uds.request('27 02 00 00 00 00', ecu);
    assert.equal(result.response[0], 0x7f);
    assert.equal(result.nrc, attempt === 3 ? 0x36 : 0x35);
  }
  assert.equal(uds.getSnapshot().security, 'delay');
  assert.equal(uds.request('27 01', ecu).nrc, 0x37);
});

test('DTC clear demonstrates session and security preconditions', () => {
  const uds = new UdsSimulator();
  const ecu = normalRun();
  assert.equal(uds.request('14 FF FF FF', ecu).nrc, 0x7e);
  uds.request('10 03', ecu);
  assert.equal(uds.request('14 FF FF FF', ecu).nrc, 0x33);
  const seed = uds.request('27 01', ecu).response.slice(2);
  uds.request([0x27, 0x02, ...deriveTeachingKey(seed)], ecu);
  const cleared = uds.request('14 FF FF FF', ecu);
  assert.deepEqual(cleared.response, [0x54]);
  assert.equal(uds.getSnapshot().dtcCount, 0);
  assert.equal(uds.request('19 02 FF', ecu).dtcs.length, 0);
});

test('bus-off is a transport failure rather than a fabricated UDS NRC', () => {
  const ecu = new BootSimulator({ scenario: 'can-bus-off' }).seek(42);
  const result = new UdsSimulator().request('22 F1 90', ecu);
  assert.equal(result.outcome, 'transport-error');
  assert.equal(result.nrc, null);
  assert.equal(result.response.length, 0);
  assert.match(result.explanation, /SILENT_COM/);
});

test('unsupported services and invalid DIDs produce negative responses', () => {
  const uds = new UdsSimulator();
  const ecu = normalRun();
  assert.deepEqual(uds.request('99', ecu).response, [0x7f, 0x99, 0x11]);
  assert.deepEqual(uds.request('22 12 34', ecu).response, [0x7f, 0x22, 0x31]);
});

test('TesterPresent supports suppressPositiveResponse and keeps the request frame', () => {
  const uds = new UdsSimulator();
  const result = uds.request('3E 80', normalRun());
  assert.equal(result.outcome, 'suppressed-positive-response');
  assert.equal(result.response.length, 0);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].phase, 'REQUEST');
  assert.equal(uds.getSnapshot().s3RefreshCount, 1);
});

test('ISO-TP frame construction preserves payload length and sequence numbers', () => {
  const payload = Array.from({ length: 24 }, (_, index) => index);
  const frames = buildIsoTpExchange([0x22, 0xf1, 0x90], payload);
  const responseFrames = frames.filter((frame) => frame.phase === 'RESPONSE');
  assert.equal(responseFrames[0].type, 'FF');
  assert.equal(responseFrames[0].payloadLength, 24);
  assert.deepEqual(responseFrames.filter((frame) => frame.type === 'CF').map((frame) => frame.sequence), [1, 2, 3]);
});

test('UDS snapshots are isolated and reset restores diagnostic defaults', () => {
  const uds = new UdsSimulator();
  uds.request('22 F1 90', normalRun());
  const snapshot = uds.getSnapshot();
  snapshot.dtcs[0].status = 0;
  snapshot.history.length = 0;
  snapshot.flash.buffer.push(0xff);
  snapshot.privateProtocol.featureFlags[0x01] = 0xff;
  assert.notEqual(uds.getSnapshot().dtcs[0].status, 0);
  assert.equal(uds.getSnapshot().history.length, 1);
  assert.equal(uds.getSnapshot().flash.buffer.length, 0);
  assert.notEqual(uds.getSnapshot().privateProtocol.featureFlags[0x01], 0xff);
  const reset = uds.reset();
  assert.equal(reset.session, 'default');
  assert.equal(reset.security, 'locked');
  assert.equal(reset.history.length, 0);
  assert.equal(reset.dtcCount, 3);
  assert.equal(reset.flash.status, 'idle');
  assert.equal(reset.privateProtocol.requestCount, 0);
});

test('firmware profiles produce deterministic CRC32 and bounded TransferData blocks', () => {
  assert.equal(crc32([...new TextEncoder().encode('123456789')]), 0xcbf43926);
  const profile = UDS_FLASH_PROFILES[0];
  const plan = buildFlashRequestPlan(profile.id);
  const transfers = plan.requests.filter((item) => item.stage === 'transfer');
  assert.equal(plan.requests[0].stage, 'erase');
  assert.equal(plan.requests.at(-1).stage, 'activate');
  assert.equal(transfers.length, 4);
  assert.ok(transfers.every((item) => item.request.length <= 16));
  assert.deepEqual(transfers.map((item) => item.request[1]), [1, 2, 3, 4]);
  assert.throws(() => buildFlashRequestPlan('missing'), /Unknown/);
  assert.throws(() => buildFlashRequestPlan(profile.id, 15), /1 to 14/);
});

test('flashing enforces programming session, unlock, erase and download order', () => {
  const uds = new UdsSimulator();
  const ecu = normalRun();
  const plan = buildFlashRequestPlan(UDS_FLASH_PROFILES[0].id);
  assert.equal(uds.request(plan.requests[1].request, ecu).nrc, 0x7e);
  enterProgrammingAndUnlock(uds, ecu);
  assert.equal(uds.request(plan.requests[1].request, ecu).nrc, 0x22);
  assert.equal(uds.request(plan.requests[2].request, ecu).nrc, 0x24);
  assert.equal(uds.request(plan.requests[0].request, ecu).positive, true);
  assert.equal(uds.request(plan.requests[1].request, ecu).positive, true);
  assert.equal(uds.request(plan.requests[3].request, ecu).nrc, 0x73);
});

test('complete teaching flash updates the active bank, version DID and progress', () => {
  const uds = new UdsSimulator();
  const ecu = normalRun();
  const profile = UDS_FLASH_PROFILES[0];
  const plan = buildFlashRequestPlan(profile.id);
  enterProgrammingAndUnlock(uds, ecu);
  for (const item of plan.requests) assert.equal(uds.request(item.request, ecu).positive, true, item.label);
  const state = uds.getSnapshot();
  assert.equal(state.flash.status, 'activated');
  assert.equal(state.flash.activeBank, 'B');
  assert.equal(state.flash.activeVersion, profile.version);
  assert.equal(state.flash.progress, 100);
  const version = uds.request('22 F1 87', ecu);
  assert.equal(new TextDecoder().decode(Uint8Array.from(version.response.slice(3))), profile.version);
});

test('incomplete transfers and bad CRC cannot activate a firmware image', () => {
  const uds = new UdsSimulator();
  const ecu = normalRun();
  const plan = buildFlashRequestPlan(UDS_FLASH_PROFILES[1].id);
  enterProgrammingAndUnlock(uds, ecu);
  uds.request(plan.requests[0].request, ecu);
  uds.request(plan.requests[1].request, ecu);
  uds.request(plan.requests[2].request, ecu);
  assert.equal(uds.request([0x37], ecu).nrc, 0x24);
  for (const item of plan.requests.filter((entry) => entry.stage === 'transfer').slice(1)) uds.request(item.request, ecu);
  assert.equal(uds.request([0x37], ecu).positive, true);
  const verify = [...plan.requests.find((item) => item.stage === 'verify').request];
  verify[7] ^= 0xff;
  assert.equal(uds.request(verify, ecu).nrc, 0x72);
  assert.equal(uds.request([0x31, 0x01, 0xff, 0x02], ecu).nrc, 0x24);
  assert.equal(uds.getSnapshot().flash.activeVersion, 'ASL-UDS-1.1');
});

test('invented OEM services remain session, security and range checked', () => {
  const uds = new UdsSimulator();
  const ecu = normalRun();
  const bootInfo = uds.request('B0 01', ecu);
  assert.equal(bootInfo.positive, true);
  assert.equal(bootInfo.privateProtocol, true);
  assert.equal(uds.request('B1 01', ecu).nrc, 0x7e);
  uds.request('10 03', ecu);
  assert.equal(uds.request('B1 01', ecu).positive, true);
  assert.equal(uds.request('B2 A5 01 01', ecu).nrc, 0x33);
  const seed = uds.request('27 01', ecu).response.slice(2);
  uds.request([0x27, 0x02, ...deriveTeachingKey(seed)], ecu);
  assert.equal(uds.request('B2 00 01 01', ecu).nrc, 0x31);
  assert.deepEqual(uds.request('B2 A5 01 01', ecu).response, [0xf2, 0x01, 0x01]);
  assert.equal(uds.getSnapshot().privateProtocol.featureFlags[0x01], 0x01);
});
