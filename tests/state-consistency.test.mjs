import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NM_TIMING, VehicleSimulator } from '../src/vehicle.mjs';
import { XcpLabSimulator } from '../src/xcp-lab.mjs';

const running = () => {
  const world = new VehicleSimulator();
  world.startAll();
  return world;
};

const dtc = (world, ecuId, id) => world.ecu(ecuId).uds.getSnapshot().dtcs.find(item => item.id === id);

test('power loss and ECU reset clear volatile runtime state but retain committed NvM data', () => {
  const world = running();
  const ecu = world.ecu('gateway');

  assert.equal(ecu.storage.writeBlock('gain', 2.4), true);
  world.tick(100);
  world.connectXcp();
  ecu.xcp.setDaq(true);
  world.setSensor(82);
  world.tick(30);
  assert.ok(ecu.counter > 0);
  assert.ok(ecu.cdd.irqCount > 0);
  assert.ok(ecu.xcp.getSnapshot().samples.length > 0);

  world.powerOff('gateway');
  assert.equal(ecu.storage.readBlock('gain'), 2.4);
  assert.equal(ecu.uds.getSnapshot().session, 'default');
  assert.equal(ecu.xcp.getSnapshot().connected, false);
  assert.equal(ecu.xcp.getSnapshot().daq, false);
  assert.equal(ecu.counter, 0);
  assert.equal(ecu.lastHeartbeat, null);
  assert.deepEqual(ecu.seenPeers, {});
  assert.deepEqual(ecu.missingPeers, []);
  assert.deepEqual(ecu.cdd.dma, [null, null]);
  assert.equal(ecu.cdd.irqCount, 0);
  assert.equal(ecu.actuator, 0);

  world.start('gateway');
  assert.equal(ecu.xcp.getSnapshot().parameters.gain, 2.4);
  world.tick(20);
  assert.equal(ecu.counter, 2, 'application alive counter restarts at one after reset');

  world.resetEcu('gateway');
  assert.equal(ecu.storage.readBlock('gain'), 2.4);
  assert.equal(ecu.counter, 0);
  assert.equal(ecu.cdd.irqCount, 0);
  assert.equal(ecu.actuator, 0);
});

test('only a Gateway reset restarts the shared multicore OS model', () => {
  const world = running();
  world.tick(120);
  const before = world.os.getSnapshot().nowMs;
  assert.ok(before > 0);

  world.resetEcu('powertrain');
  assert.equal(world.os.getSnapshot().nowMs, before, 'a satellite ECU does not own the Gateway OS');

  world.resetEcu('gateway');
  const reset = world.os.getSnapshot();
  assert.equal(reset.nowMs, 0);
  assert.equal(reset.barrier, 'released');
  assert.ok(reset.cores.every(core => core.online && core.running === null));
});

test('vehicle Bus-Off recovery makes the boot and diagnostic views agree', () => {
  const world = running();
  const gateway = world.ecu('gateway');
  gateway.boot.reset('can-bus-off');
  world.start('gateway');

  assert.equal(world.available('gateway'), false);
  const busOff = world.diagnosticState('gateway');
  assert.equal(busOff.can.state, 'BUS_OFF');
  assert.equal(busOff.can.actual, 'SILENT_COM');

  world.setBusOff('gateway', true);
  world.setBusOff('gateway', false);
  const recovered = world.diagnosticState('gateway');
  assert.equal(gateway.busOff, false);
  assert.equal(recovered.status, 'running');
  assert.equal(recovered.can.actual, 'FULL_COM');
  assert.equal(recovered.can.txEnabled, true);
  assert.equal(gateway.boot.getSnapshot().can.actual, 'FULL_COM');
  assert.equal(gateway.boot.getSnapshot().can.txEnabled, true);
  assert.equal(world.available('gateway'), true);
});

test('a DTC rejected by a full NvM queue is not reported as queued and is retried durably', () => {
  const world = running();
  const gateway = world.ecu('gateway');

  // Inject a saturated lower-layer queue. Public writes intentionally coalesce
  // the four teaching blocks, so distinct synthetic jobs are used as a precise
  // capacity fault fixture rather than weakening production admission rules.
  assert.equal(gateway.storage.writeBlock('gain', 1.1), true);
  gateway.storage.queue.push(...Array.from({ length: 32 }, (_, index) => ({
    id: 10_000 + index,
    name: `capacity-fixture-${index}`,
    value: index,
    crcFault: false,
  })));
  world.setCddFault(true, 'gateway');

  assert.equal(dtc(world, 'gateway', 0xa10202)?.status, 0x09);
  assert.equal(gateway.storage.events.at(-1)?.type, 'rejected');
  const initialDem = world.events.findLast(event => event.ecuId === 'gateway' && event.kind === 'Dem');
  assert.doesNotMatch(initialDem.detail, /已排队保存/);
  assert.match(initialDem.detail, /重试|等待|未接受/);
  assert.equal(gateway.storage.readBlock('dtcs').some(item => item.id === 0xa10202), false);

  world.tick(5_000);
  assert.ok(gateway.storage.readBlock('dtcs').some(item => item.id === 0xa10202 && item.status === 0x09));
  assert.equal(Object.hasOwn(gateway.pendingWrites, 'dtcs'), false);
  assert.ok(world.events.some(event => event.ecuId === 'gateway' && event.kind === 'NvM'
    && event.detail.includes('dtcs') && event.detail.includes('耐久提交')));
});

test('disconnecting XCP repeatedly is an idempotent state transition', () => {
  const xcp = new XcpLabSimulator();
  xcp.connect();
  xcp.setDaq(true);
  xcp.tick(20, { sensor: 40 });

  xcp.disconnect();
  const disconnected = xcp.getSnapshot();
  xcp.disconnect();
  assert.deepEqual(xcp.getSnapshot(), disconnected);
});

test('latest calibration intent wins when it returns to the committed value during an earlier write', () => {
  const world = running();
  world.connectXcp();
  world.calibrate('gain', 3);
  world.saveCalibration();
  world.calibrate('gain', 1.6);
  const latest = world.saveCalibration();
  assert.equal(latest.durable, false);
  world.tick(250);
  assert.equal(world.ecu().storage.readBlock('gain'), 1.6);
  assert.deepEqual(world.ecu().pendingWrites, {});
});

test('an expected ECU that never produced a heartbeat times out after the supervision window', () => {
  const world = running();
  // Remove Body before its first 10 ms application sample. A missing timestamp
  // must not disable supervision of a configured peer indefinitely.
  world.powerOff('body');
  world.tick(NM_TIMING.heartbeatTimeout + 100);

  const gateway = world.ecu('gateway');
  assert.equal(gateway.seenPeers.body, undefined);
  assert.equal(gateway.missingPeers.includes('body'), true);
  assert.equal(dtc(world, 'gateway', 0xc10004)?.status, 0x09);
});

test('automatic flash owns only the clock it started and releases it on every terminal path', async () => {
  const source = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(source, /if\s*\(!vehiclePlaying\)\s*flashClockStarted\s*=\s*true/);
  assert.match(source, /function stopAutomaticFlashClock\(\)[\s\S]*if\s*\(!flashClockStarted\)\s*return;[\s\S]*vehiclePlaying\s*=\s*false/);
  assert.match(source, /else\s*\{\s*automaticFlash\s*=\s*false;\s*stopAutomaticFlashClock\(\);\s*\}/);
  assert.match(source, /automaticFlash\s*=\s*false;\s*stopAutomaticFlashClock\(\);\s*if\s*\(failure\)/);
});
