import test from 'node:test';
import assert from 'node:assert/strict';
import { VehicleSimulator, ECU_PROFILES } from '../src/vehicle.mjs';
import { deriveTeachingKey } from '../src/uds.mjs';

const running = () => { const world = new VehicleSimulator(); world.startAll(); return world; };

test('vehicle starts four independent ECUs and routes diagnostics to the selected target', () => {
  const world = running();
  assert.ok(world.getSnapshot().ecus.every(ecu => ecu.powered && ecu.bootStatus === 'running'));
  world.select('body');
  assert.equal(world.request('10 03').positive, true);
  assert.equal(world.ecu().uds.getSnapshot().session, 'extended');
  assert.equal(world.ecu('gateway').uds.getSnapshot().session, 'default');
  assert.equal(world.request('22 F1 90').frames[0].canId, '0x7E3');
  world.setBusOff('gateway', true);
  assert.equal(world.available('body'), false);
  assert.equal(world.request('22 F1 90').outcome, 'transport-error');
  world.setBusOff('gateway', false);
  assert.equal(world.available('body'), true);
});

test('power loss stops target traffic and peer timeout DTC becomes durable after the storage job', () => {
  const world = running();
  world.tick(20);
  world.powerOff('body');
  const offTime = world.nowMs;
  world.tick(600);
  assert.equal(world.ecu('gateway').missingPeers.includes('body'), false);
  world.tick(10);
  const gateway = world.ecu('gateway');
  assert.ok(gateway.missingPeers.includes('body'));
  assert.ok(gateway.uds.getSnapshot().dtcs.some(dtc => dtc.id === 0xc10004 && dtc.status === 9));
  assert.equal(gateway.storage.readBlock('dtcs').some(dtc => dtc.id === 0xc10004), false);
  assert.equal(world.frames.some(frame => frame.ecuId === 'body' && frame.time > offTime && ['NM', 'APP'].includes(frame.kind)), false);
  world.tick(60);
  assert.ok(gateway.storage.readBlock('dtcs').some(dtc => dtc.id === 0xc10004 && dtc.status === 9));
  world.start('body'); world.tick(10);
  assert.equal(gateway.missingPeers.includes('body'), false);
  assert.equal(gateway.uds.getSnapshot().dtcs.find(dtc => dtc.id === 0xc10004).status, 8);
});

test('network release reaches bus sleep and a gateway wake propagates to peers', () => {
  const world = running();
  for (const ecu of ECU_PROFILES) world.requestNetwork(ecu.id, false);
  world.tick(6000);
  assert.ok(world.getSnapshot().ecus.every(ecu => ecu.nm === 'BUS_SLEEP'));
  world.wake('gateway');
  world.tick(10);
  assert.ok(world.getSnapshot().ecus.every(ecu => ecu.nm === 'REPEAT_MESSAGE'));
});

test('XCP calibration changes actuator and only committed calibration survives power reset', () => {
  const world = running();
  world.connectXcp();
  world.setSensor(60);
  world.tick(200);
  const original = world.ecu().actuator;
  world.calibrate('gain', 3);
  world.tick(10);
  assert.ok(world.ecu().actuator > original);
  world.resetEcu();
  assert.equal(world.ecu().xcp.getSnapshot().parameters.gain, 1.6);
  world.connectXcp(); world.calibrate('gain', 3); world.saveCalibration();
  assert.equal(world.ecu().storage.readBlock('gain'), 1.6);
  world.tick(180);
  assert.equal(world.ecu().storage.readBlock('gain'), 3);
  world.resetEcu();
  assert.equal(world.ecu().xcp.getSnapshot().parameters.gain, 3);
});

test('CDD CRC fault gates actuator, reports Dem and recovers valid acquisition', () => {
  const world = running(); world.tick(20);
  world.setCddFault(true); world.tick(10);
  assert.equal(world.ecu().actuator, 0);
  assert.equal(world.ecu().cdd.quality, 'INVALID');
  assert.equal(world.ecu().uds.getSnapshot().dtcs.find(dtc => dtc.id === 0xa10202).status, 9);
  world.setCddFault(false); world.tick(10);
  assert.equal(world.ecu().cdd.quality, 'VALID');
  assert.ok(world.ecu().actuator > 0);
  assert.equal(world.ecu().uds.getSnapshot().dtcs.find(dtc => dtc.id === 0xa10202).status, 8);
});

test('world clock retains fractional input and produces identical partitioned state', () => {
  const first = running(); const second = running();
  first.tick(299);
  for (const ms of [3, 7, 99, 100, 90]) second.tick(ms);
  assert.deepEqual(first.getSnapshot(), second.getSnapshot());
  assert.equal(first.nowMs, 290);
  first.tick(1); second.tick(1);
  assert.deepEqual(first.getSnapshot(), second.getSnapshot());
  assert.equal(first.nowMs, 300);
});

test('asynchronous diagnostic erase is recorded once at completion in the shared trace', () => {
  const world = running();
  world.request('10 02');
  const seed = world.request('27 01').response.slice(2);
  world.request([0x27, 2, ...deriveTeachingKey(seed)]);
  assert.equal(world.request('31 01 FF 00').nrc, 0x78);
  const completed = () => world.events.filter(event => event.kind === 'UDS' && event.detail.includes('71 01 FF 00 00'));
  world.tick(240); assert.equal(completed().length, 0);
  world.tick(10); assert.equal(completed().length, 1);
  world.tick(200); assert.equal(completed().length, 1);
});
