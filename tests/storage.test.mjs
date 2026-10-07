import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageSimulator } from '../src/storage.mjs';

test('NvM acceptance is distinct from durable completion', () => {
  const storage = new StorageSimulator();
  assert.equal(storage.writeBlock('gain', 2), true);
  storage.tick(59);
  assert.equal(storage.readBlock('gain'), 1.6);
  storage.tick(1);
  assert.equal(storage.readBlock('gain'), 2);
  assert.deepEqual(storage.events.slice(1, 7).map(event => event.type), ['NvM', 'MemIf', 'Fee', 'Fls', 'verify', 'commit']);
});

test('power interruption at every write stage retains previous committed value', () => {
  for (const elapsed of [0, 9, 10, 20, 30, 40, 50, 59]) {
    const storage = new StorageSimulator();
    storage.writeBlock('gain', 2);
    storage.tick(60);
    storage.writeBlock('gain', 3);
    storage.writeBlock('filter', 0.8);
    storage.tick(elapsed);
    storage.powerOff();
    storage.tick(100);
    storage.powerOn();
    assert.equal(storage.readBlock('gain'), 2, `cut at ${elapsed}`);
    assert.equal(storage.readBlock('filter'), 0.22);
    assert.equal(storage.activeJob, null);
    assert.equal(storage.queue.length, 0);
  }
});

test('CRC failure and write protection preserve committed data', () => {
  const storage = new StorageSimulator();
  storage.injectCrcFault();
  storage.writeBlock('threshold', 60);
  storage.tick(100);
  assert.equal(storage.status, 'crc-error');
  storage.powerOff(); storage.powerOn();
  assert.equal(storage.readBlock('threshold'), 48);
  storage.setWriteProtected(true);
  assert.equal(storage.writeBlock('gain', 2), false);
  storage.setWriteProtected(false);
  storage.writeBlock('gain', 2);
  storage.tick(60);
  assert.equal(storage.readBlock('gain'), 2);
});

test('GC copy and sector switch tolerate interruption and retain all blocks', () => {
  for (const elapsed of [29, 30, 39, 40, 49, 50, 60, 70, 79, 80]) {
    const storage = new StorageSimulator();
    for (let i = 0; i < 8; i++) {
      storage.writeBlock(i % 2 ? 'gain' : 'threshold', i + 1);
      storage.tick(60);
    }
    storage.writeBlock('gain', 9);
    storage.tick(elapsed);
    storage.powerOff(); storage.powerOn();
    assert.equal(storage.readBlock('gain'), elapsed === 80 ? 9 : 8);
    assert.equal(storage.readBlock('threshold'), 7);
    storage.writeBlock('filter', 0.5);
    storage.tick(100);
    assert.equal(storage.readBlock('filter'), 0.5);
    assert.ok(storage.sectors.every(sector => sector.length <= 8));
  }
});

test('queued writes and GC are independent of tick partitioning', () => {
  const large = new StorageSimulator();
  const small = new StorageSimulator();
  for (const storage of [large, small]) for (let i = 0; i < 20; i++) storage.writeBlock('threshold', i);
  large.tick(2000);
  for (let i = 0; i < 2000; i++) small.tick(1);
  assert.deepEqual(large.getSnapshot(), small.getSnapshot());
  assert.equal(large.readBlock('threshold'), 19);
  assert.ok(large.gcCount > 0);
  assert.ok(large.events.length <= 160);
});

test('storage validates values and snapshots cannot mutate durable state', () => {
  const storage = new StorageSimulator();
  assert.throws(() => storage.writeBlock('missing', 1));
  assert.throws(() => storage.writeBlock('filter', 2));
  assert.throws(() => storage.writeBlock('gain', NaN));
  assert.throws(() => storage.tick(-1));
  const dtcs = ['123456'];
  storage.writeBlock('dtcs', dtcs);
  dtcs.push('FFFFFF');
  storage.tick(60);
  storage.readBlock('dtcs').push('000000');
  storage.getSnapshot().blocks.dtcs.push('000001');
  assert.deepEqual(storage.readBlock('dtcs'), ['123456']);
});

test('full Dem records survive persistence with independent copies and validated fields', () => {
  const storage = new StorageSimulator();
  const records = [{ id: 0xc10087, status: 0x28, label: 'CAN signal missing', origin: 'PRIMARY_MEMORY', count: 2 }];
  storage.writeBlock('dtcs', records);
  records[0].status = 0;
  storage.tick(60);
  storage.powerOff(); storage.powerOn();
  assert.equal(storage.readBlock('dtcs')[0].status, 0x28);
  assert.equal(storage.readBlock('dtcs')[0].origin, 'PRIMARY_MEMORY');
  assert.throws(() => storage.writeBlock('dtcs', [{ id: 0xffffff + 1, status: 0, label: 'invalid' }]));
  assert.throws(() => storage.writeBlock('dtcs', [{ id: 1, status: 256, label: 'invalid' }]));
  assert.throws(() => storage.writeBlock('dtcs', [{ id: 1, status: 0, label: 'invalid', extra: { nested: true } }]));
});
