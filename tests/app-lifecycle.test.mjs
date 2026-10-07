import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ExtendedLabUi } from '../src/extended-ui.mjs';
import { VehicleSimulator } from '../src/vehicle.mjs';

const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
const synchronizeRuntime = new Function('vehicle', 'engine', `${app.match(/function syncSelectedRuntimeWithBoot\(\) \{[\s\S]*?\n\}/)[0]}\nsyncSelectedRuntimeWithBoot();`);
const root = { querySelector: () => null };
const target = id => ({ dataset: { ecu: id } });
const world = {
  ecu: () => ({ id: 'gateway' }),
  powerOff: () => { throw new Error('fallback powerOff must not run'); },
  start: () => { throw new Error('fallback start must not run'); },
  startAll: () => { throw new Error('fallback startAll must not run'); },
};

test('extended system controls delegate ECU lifecycle ownership to the application', () => {
  const calls = [];
  let renders = 0;
  const ui = new ExtendedLabUi({
    world,
    advance: () => {},
    onChange: () => { renders += 1; },
    actions: {
      powerOff: id => calls.push(['off', id]),
      powerOn: id => calls.push(['on', id]),
      startAll: () => calls.push(['all']),
    },
  });

  ui.act('power-off', target('body'), root);
  ui.act('power-on', target('chassis'), root);
  ui.act('start-all', target('gateway'), root);

  assert.deepEqual(calls, [['off', 'body'], ['on', 'chassis'], ['all']]);
  assert.equal(renders, 3);
});

test('extended action failures are rendered as error notifications', () => {
  const notices = [];
  const ui = new ExtendedLabUi({
    world,
    advance: () => {},
    onChange: () => {},
    notify: (...args) => notices.push(args),
    actions: { powerOn: () => { throw new Error('ECU start failed'); } },
  });

  ui.act('power-on', target('powertrain'), root);

  assert.deepEqual(notices, [['ECU start failed', true]]);
});

test('render synchronization preserves NetworkRelease through bus sleep and restores boot data once', () => {
  const vehicle = new VehicleSimulator();
  vehicle.startAll();
  const ecu = vehicle.ecu();
  ecu.storage.writeBlock('gain', 2.4);
  vehicle.tick(100);

  // Reproduce startup replay: power is restored before the Boot player runs.
  vehicle.powerOff();
  ecu.powered = true;
  ecu.storage.powerOn();
  ecu.boot.seek(42);
  vehicle.diagnosticState();
  synchronizeRuntime(vehicle, ecu.boot);
  assert.equal(ecu.xcp.getSnapshot().parameters.gain, 2.4);

  for (const peer of Object.values(vehicle.ecus)) vehicle.requestNetwork(peer.id, false);
  for (let i = 0; i < 6; i++) {
    synchronizeRuntime(vehicle, ecu.boot);
    assert.equal(ecu.requested, false);
    vehicle.tick(1000);
  }
  assert.ok(vehicle.getSnapshot().ecus.every(peer => peer.nm === 'BUS_SLEEP'));
});

test('startup replay resets shared runtime and auto flash owns only the clock it starts', () => {
  assert.match(app, /function prepareStartupLifecycle\(\)[\s\S]*?powerOffVehicle\(id\)[\s\S]*?ecu\.powered = true/);
  assert.match(app, /function seek\(cursor\) \{\s*prepareStartupLifecycle\(\)/);
  assert.match(app, /function reset\(scenario\) \{\s*prepareStartupLifecycle\(\)/);
  assert.match(app, /function syncSelectedRuntimeWithBoot\(\)[\s\S]*?vehicle\.diagnosticState\(ecu\.id\)/);
  assert.match(app, /function startAutomaticFlashClock\(\) \{\s*if \(!vehiclePlaying\) flashClockStarted = true;/);
  assert.match(app, /function stopAutomaticFlashClock\(\) \{\s*if \(!flashClockStarted\) return;/);
  assert.match(app, /function selectVehicle\(id\)[\s\S]*?if \(flashClockStarted\) \{\s*automaticFlash = false;\s*stopAutomaticFlashClock\(\);/);
});
