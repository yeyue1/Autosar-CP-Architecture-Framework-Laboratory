import test from 'node:test';
import assert from 'node:assert/strict';
import { XcpLabSimulator } from '../src/xcp-lab.mjs';

test('XCP calibration and DAQ require connection and validated parameters', () => {
  const xcp = new XcpLabSimulator();
  assert.throws(() => xcp.calibrate('gain', 2), /Connect/);
  assert.throws(() => xcp.setDaq(true), /Connect/);
  xcp.connect(); xcp.calibrate('gain', 2);
  assert.equal(xcp.getSnapshot().parameters.gain, 2);
  for (const [name, value] of [['gain', 11], ['filter', 0], ['threshold', NaN], ['unknown', 2]]) assert.throws(() => xcp.calibrate(name, value), RangeError);
});

test('DAQ collects periodic immutable samples and stops on disconnect', () => {
  const xcp = new XcpLabSimulator(); const signals = { raw: 50, filtered: 40 };
  xcp.connect(); xcp.setDaq(true); xcp.tick(25, signals);
  signals.raw = 90;
  assert.deepEqual(xcp.getSnapshot().samples.map(s => s.timeMs), [10, 20]);
  assert.equal(xcp.getSnapshot().samples[0].signals.raw, 50);
  xcp.disconnect(); xcp.tick(100, signals);
  assert.equal(xcp.getSnapshot().samples.length, 2);
  assert.equal(xcp.getSnapshot().daq, false);
});

test('storage calibration restore is atomic and independent of connection', () => {
  const xcp = new XcpLabSimulator();
  xcp.loadCalibration({ gain: 3, filter: 0.3, threshold: 60 });
  assert.throws(() => xcp.loadCalibration({ gain: 2, filter: 4 }));
  assert.equal(xcp.getSnapshot().parameters.gain, 3);
  assert.equal(xcp.getSnapshot().connected, false);
});

test('DAQ bounds history and tick partition preserves sampling', () => {
  const a = new XcpLabSimulator(); const b = new XcpLabSimulator();
  for (const xcp of [a, b]) { xcp.connect(); xcp.setDaq(true); }
  a.tick(3000, { raw: 2 });
  for (let i = 0; i < 300; i++) b.tick(10, { raw: 2 });
  assert.equal(a.getSnapshot().samples.length, 240);
  assert.deepEqual(a.getSnapshot(), b.getSnapshot());
});
