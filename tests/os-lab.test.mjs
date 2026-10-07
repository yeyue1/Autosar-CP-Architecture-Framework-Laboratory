import test from 'node:test';
import assert from 'node:assert/strict';
import { OsLabSimulator } from '../src/os-lab.mjs';

test('OS runs separate cores and preempts background for diagnostics', () => {
  const os = new OsLabSimulator();
  os.tick(1);
  assert.deepEqual(os.getSnapshot().cores.map(c => c.running), ['background', 'control', 'comm']);
  os.activate('diagnostic');
  os.tick(1);
  assert.equal(os.getSnapshot().cores[0].running, 'diagnostic');
  assert.equal(os.getSnapshot().tasks.find(t => t.id === 'background').state, 'Ready');
  os.tick(2);
  assert.equal(os.getSnapshot().cores[0].running, 'background');
});

test('single core uses fixed priorities and periodic Alarm release', () => {
  const os = new OsLabSimulator({ cores: 1 });
  os.tick(1);
  assert.equal(os.getSnapshot().cores[0].running, 'control');
  os.tick(20);
  assert.equal(os.getSnapshot().cores[0].running, 'control');
  assert.ok(os.getSnapshot().tasks.find(t => t.id === 'comm').completed >= 2);
});

test('IOC preserves order and pauses delivery when receiver core is offline', () => {
  const os = new OsLabSimulator();
  os.sendIoc('first'); os.sendIoc('second');
  os.setCoreOnline(2, false); os.tick(5);
  assert.equal(os.getSnapshot().ioc.deliveries.length, 0);
  assert.equal(os.getSnapshot().barrier, 'waiting');
  os.setCoreOnline(2, true); os.tick(2);
  assert.deepEqual(os.getSnapshot().ioc.deliveries.map(d => d.value), ['first', 'second']);
  assert.equal(os.getSnapshot().barrier, 'released');
});

test('spinlock contention consumes a waiting core and then releases', () => {
  const os = new OsLabSimulator();
  os.setLockContention(true); os.tick(1);
  assert.equal(os.getSnapshot().spinlock.owner, 'control');
  assert.deepEqual(os.getSnapshot().spinlock.waiters, ['comm']);
  assert.equal(os.getSnapshot().tasks.find(t => t.id === 'comm').remaining, 2);
  os.tick(3);
  assert.equal(os.getSnapshot().spinlock.owner, null);
  assert.equal(os.getSnapshot().tasks.find(t => t.id === 'comm').completed, 1);
});

test('Cat2 ISR sets an event while Cat1 has no OS service side effects', () => {
  for (const category of [1, 2]) {
    const os = new OsLabSimulator();
    os.triggerInterrupt(0, category); os.tick(2);
    assert.equal(os.getSnapshot().tasks.find(t => t.id === 'event').state, category === 2 ? 'Ready' : 'Waiting');
  }
});

test('offline pending tasks produce deadline misses and remain recoverable', () => {
  const os = new OsLabSimulator();
  os.setCoreOnline(1, false); os.tick(21);
  assert.equal(os.getSnapshot().tasks.find(t => t.id === 'control').deadlineMisses, 1);
  os.setCoreOnline(1, true); os.tick(4);
  assert.equal(os.getSnapshot().tasks.find(t => t.id === 'control').completed, 1);
});

test('OS timing is invariant to fractional tick partition', () => {
  const whole = new OsLabSimulator(); const split = new OsLabSimulator();
  whole.tick(100);
  for (let i = 0; i < 1000; i++) split.tick(0.1);
  assert.deepEqual(split.getSnapshot(), whole.getSnapshot());
});
