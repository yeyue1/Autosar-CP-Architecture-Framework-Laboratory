import test from 'node:test';
import assert from 'node:assert/strict';
import { UdsSimulator, buildIsoTpExchange, buildFlashRequestPlan, deriveTeachingKey } from '../src/uds.mjs';

const ecu = { modules: { dcm: 'ready' }, can: { actual: 'FULL_COM', txEnabled: true } };
const send = (uds, bytes) => uds.request(bytes, ecu);
function unlock(uds) {
  send(uds, '10 02');
  const seed = send(uds, '27 01').response.slice(2);
  send(uds, [0x27, 2, ...deriveTeachingKey(seed)]);
}

test('S3 advances only with virtual time and suppressed keepalive refreshes it', () => {
  const uds = new UdsSimulator({ s3Ms: 100 });
  assert.equal(send(uds, '10 83').outcome, 'suppressed-positive-response');
  assert.equal(uds.tick(99).session, 'extended');
  send(uds, '3E 80');
  assert.equal(uds.tick(99).s3RemainingMs, 1);
  const expired = uds.tick(1);
  assert.equal(expired.session, 'default');
  assert.equal(expired.security, 'locked');
  assert.equal(expired.s3RemainingMs, null);
});

test('security delay recovers exactly on deadline and cannot be bypassed by session change', () => {
  const uds = new UdsSimulator({ securityDelayMs: 100 });
  send(uds, '10 03');
  for (let i = 0; i < 3; i += 1) {
    send(uds, '27 01');
    send(uds, '27 02 00 00 00 00');
  }
  send(uds, '10 02');
  assert.equal(send(uds, '27 01').nrc, 0x37);
  assert.equal(uds.tick(99).security, 'delay');
  assert.equal(uds.tick(1).security, 'locked');
  assert.equal(send(uds, '27 01').positive, true);
});

test('pending erase commits only at completion and time partitions agree', () => {
  const make = () => {
    const uds = new UdsSimulator({ asyncEraseMs: 200, s3Ms: 100 });
    assert.equal(send(uds, '31 01 FF 00').nrc, 0x7e);
    assert.equal(uds.getSnapshot().pendingOperation, null);
    unlock(uds);
    assert.equal(send(uds, '31 01 FF 00').nrc, 0x78);
    assert.equal(uds.getSnapshot().flash.erased, false);
    assert.equal(send(uds, buildFlashRequestPlan('application-v120').requests[1].request).nrc, 0x24);
    return uds;
  };
  const first = make();
  assert.equal(first.tick(199).flash.erased, false);
  const completed = first.tick(1);
  assert.equal(completed.flash.erased, true);
  assert.equal(completed.latest.deferred, true);
  assert.deepEqual(completed.latest.response, [0x71, 1, 0xff, 0, 0]);
  assert.equal(completed.latest.frames.some((frame) => frame.phase === 'REQUEST'), false);
  first.tick(99);
  const second = make();
  second.tick(299);
  assert.deepEqual(first.getSnapshot(), second.getSnapshot());
  assert.equal(first.tick(1).session, 'default');
});

test('reset cancels pending erase and activated firmware survives reset and S3 timeout', () => {
  const pending = new UdsSimulator({ asyncEraseMs: 200 });
  unlock(pending);
  send(pending, '31 01 FF 00');
  pending.reset();
  assert.equal(pending.tick(200).flash.erased, false);
  const uds = new UdsSimulator();
  unlock(uds);
  for (const { request } of buildFlashRequestPlan('application-v120').requests) assert.equal(send(uds, request).positive, true);
  const version = uds.getSnapshot().flash.activeVersion;
  assert.equal(uds.tick(5000).flash.activeVersion, version);
  assert.equal(uds.reset().flash.activeVersion, version);
});

test('CAN FD uses escaped SF length and correct FF/CF capacities with independent IDs', () => {
  const options = { canFd: true, testerCanId: 0x701, ecuCanId: 0x709 };
  const short = buildIsoTpExchange([0x22, 0xf1, 0x90], Array(20).fill(0x62), options);
  assert.equal(short.length, 2);
  assert.equal(short[0].canId, '0x701');
  assert.equal(short[1].canId, '0x709');
  assert.deepEqual(short[1].data.slice(0, 2), [0, 20]);
  assert.equal(short[1].data.length, 64);
  assert.equal(buildIsoTpExchange(Array(62).fill(1), [], options)[0].type, 'SF');
  const payload = Array.from({ length: 140 }, (_, i) => i);
  const frames = buildIsoTpExchange(payload, [], options);
  assert.deepEqual(frames.map((frame) => frame.type), ['FF', 'FC', 'CF', 'CF']);
  const reconstructed = [...frames[0].data.slice(2), ...frames[2].data.slice(1), ...frames[3].data.slice(1)].slice(0, payload.length);
  assert.deepEqual(reconstructed, payload);
});

test('invalid timers and transport inputs fail before mutation; reported DTC is readable', () => {
  assert.throws(() => new UdsSimulator({ s3Ms: NaN }), RangeError);
  const uds = new UdsSimulator();
  const before = uds.getSnapshot();
  assert.throws(() => uds.tick(-1), RangeError);
  assert.throws(() => uds.setTransport({ ecuCanId: -1 }), RangeError);
  assert.throws(() => buildIsoTpExchange(Array(4096).fill(1)), RangeError);
  assert.deepEqual(uds.getSnapshot(), before);
  uds.reportDtc(0xaabbcc, 0x08, 'ECU missing');
  assert.ok(send(uds, '19 02 08').dtcs.some((dtc) => dtc.id === 0xaabbcc));
});
