import test from 'node:test';
import assert from 'node:assert/strict';
import { BootSimulator } from '../src/engine.mjs';
import { LabPlayer } from '../src/player.mjs';
import { STEPS } from '../src/model.mjs';

test('playback starts paused and changes no state without play', () => {
  const engine = new BootSimulator();
  const player = new LabPlayer(engine);
  const initial = engine.getSnapshot();
  assert.deepEqual(player.advance(1000), { changed: false, breakpoint: null });
  assert.deepEqual(engine.getSnapshot(), initial);
});

test('playback speed affects wall time but not startup virtual results', () => {
  const normal = new LabPlayer(new BootSimulator());
  const fast = new LabPlayer(new BootSimulator());
  normal.play(); fast.setSpeed(4); fast.play();
  normal.advance(900); fast.advance(225);
  assert.equal(normal.engine.getSnapshot().cursor, 1);
  assert.deepEqual(normal.engine.getSnapshot(), fast.engine.getSnapshot());
});

test('breakpoints stop before a step and continuing crosses it exactly once', () => {
  const player = new LabPlayer(new BootSimulator());
  player.toggleBreakpoint(2);
  player.play();
  const result = player.advance(5000);
  assert.equal(result.breakpoint, 2);
  assert.equal(player.engine.getSnapshot().cursor, 1);
  assert.equal(player.playing, false);
  player.play(); player.advance(900);
  assert.equal(player.engine.getSnapshot().cursor, 2);
  assert.equal(player.breakpoints.has(2), true);
  player.seek(0); player.play();
  assert.equal(player.advance(5000).breakpoint, 2);
});

test('breakpoint on first instruction is not silently skipped', () => {
  const player = new LabPlayer(new BootSimulator());
  player.toggleBreakpoint(1); player.play();
  assert.equal(player.advance(900).breakpoint, 1);
  assert.equal(player.engine.getSnapshot().cursor, 0);
  player.step();
  assert.equal(player.engine.getSnapshot().cursor, 1);
  assert.equal(player.playing, false);
});

test('seek and reset pause playback, preserve breakpoints, and clear pending timing', () => {
  const player = new LabPlayer(new BootSimulator());
  player.toggleBreakpoint(30); player.play(); player.advance(950);
  player.seek(4);
  assert.equal(player.playing, false);
  assert.equal(player.elapsed, 0);
  player.reset();
  assert.equal(player.engine.getSnapshot().cursor, 0);
  assert.equal(player.breakpoints.has(30), true);
});

test('RUN advances with ticks and manual single-step advances 10ms', () => {
  const player = new LabPlayer(new BootSimulator());
  player.seek(STEPS.length);
  const before = player.engine.getSnapshot();
  player.step();
  assert.equal(player.engine.getSnapshot().time, before.time + 10);
  player.play(); player.advance(20);
  assert.equal(player.engine.getSnapshot().time, before.time + 30);
});

test('blocking scenario cannot be bypassed by continuing playback', () => {
  const player = new LabPlayer(new BootSimulator({ scenario: 'pll-failure' }));
  player.play(); player.advance(900 * STEPS.length);
  const blocked = player.engine.getSnapshot();
  assert.equal(blocked.status, 'blocked');
  assert.equal(player.playing, false);
  assert.equal(player.play(), false);
  player.advance(1000);
  assert.deepEqual(player.engine.getSnapshot(), blocked);
});

test('invalid playback parameters and breakpoint ids are rejected', () => {
  const player = new LabPlayer(new BootSimulator());
  for (const speed of [0, -1, 3, NaN, Infinity, '4']) assert.throws(() => player.setSpeed(speed), RangeError);
  for (const id of [0, -1, STEPS.length + 1, 2.5, NaN]) assert.throws(() => player.toggleBreakpoint(id), RangeError);
  for (const time of [-1, NaN, Infinity]) assert.throws(() => player.advance(time), RangeError);
  assert.throws(() => player.reset('unknown'), RangeError);
});
