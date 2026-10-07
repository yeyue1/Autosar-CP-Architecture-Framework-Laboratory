import test from 'node:test';
import assert from 'node:assert/strict';
import { TransportSimulator } from '../src/transport-lab.mjs';
const bytes = size => Array.from({ length: size }, (_, index) => index & 255);

test('classic and CAN FD SF/FF boundary encodings and valid DLC lengths', () => {
  for (const [canFd, length, type, header] of [[false, 7, 'SF', [7]], [false, 8, 'FF', [0x10, 8]], [true, 7, 'SF', [7]], [true, 8, 'SF', [0, 8]], [true, 62, 'SF', [0, 62]], [true, 63, 'FF', [0x10, 63]]]) {
    const transport = new TransportSimulator({ canFd });
    transport.start(bytes(length)); transport.tick(1000);
    assert.equal(transport.frames[0].type, type);
    assert.deepEqual(transport.frames[0].data.slice(0, header.length), header);
    assert.deepEqual(transport.received, bytes(length));
    assert.ok(transport.frames.every(frame => (canFd ? [8, 12, 16, 20, 24, 32, 48, 64] : [8]).includes(frame.data.length)));
  }
});

test('receiver publishes only complete data; FC, blocksize and STmin control CF emission', () => {
  const transport = new TransportSimulator();
  transport.start(bytes(24)); transport.step();
  assert.equal(transport.frames[0].type, 'FF');
  assert.deepEqual(transport.received, []);
  transport.step();
  assert.deepEqual(transport.frames[1].data.slice(0, 3), [0x30, 2, 10]);
  transport.tick(9);
  assert.equal(transport.frames.length, 2);
  transport.tick(1); transport.tick(100);
  assert.deepEqual(transport.frames.map(frame => frame.type), ['FF', 'FC', 'CF', 'CF', 'FC', 'CF']);
  assert.deepEqual(transport.frames.map(frame => frame.time), [0, 1, 11, 21, 22, 32]);
  assert.deepEqual(transport.received, bytes(24));
});

test('unlimited BS and sequence nibble wrap work for long payloads', () => {
  const transport = new TransportSimulator({ blockSize: 0, stMinMs: 0 });
  transport.start(bytes(4095)); transport.tick(1000);
  assert.equal(transport.status, 'complete');
  assert.equal(transport.frames.filter(frame => frame.type === 'FC').length, 1);
  const cfs = transport.frames.filter(frame => frame.type === 'CF');
  assert.equal(cfs[15].data[0], 0x20);
  assert.deepEqual(transport.received, bytes(4095));
  assert.ok(transport.frames.length <= 1024);
});

test('missing FC/CF and sequence faults never deliver partial application payloads', () => {
  for (const fault of ['drop-fc', 'drop-cf', 'wrong-sequence']) {
    const transport = new TransportSimulator();
    transport.setFault(fault); transport.start(bytes(24)); transport.tick(500);
    assert.equal(transport.status, fault === 'wrong-sequence' ? 'error' : 'timeout');
    assert.deepEqual(transport.received, []);
    assert.ok(transport.error);
    if (fault === 'drop-fc') assert.equal(transport.frames.filter(frame => frame.type === 'CF').length, 0);
  }
});

test('partitioned ticks produce identical transport histories', () => {
  for (const fault of ['none', 'drop-fc', 'drop-cf', 'wrong-sequence']) {
    const large = new TransportSimulator(); const small = new TransportSimulator();
    for (const transport of [large, small]) { transport.setFault(fault); transport.start(bytes(200)); }
    large.tick(1000);
    for (let i = 0; i < 1000; i++) small.tick(1);
    assert.deepEqual(large.getSnapshot(), small.getSnapshot());
  }
});

test('step exposes one frame even with zero STmin and loss timeout uses receiver deadline', () => {
  const zero = new TransportSimulator({ stMinMs: 0 });
  zero.start(bytes(24));
  zero.step(); zero.step(); zero.step();
  assert.equal(zero.frames.length, 3);
  assert.equal(zero.status, 'transferring');
  const loss = new TransportSimulator();
  loss.setFault('drop-cf'); loss.start(bytes(24));
  loss.tick(121);
  assert.equal(loss.status, 'transferring');
  loss.tick(1);
  assert.equal(loss.status, 'timeout');
  assert.equal(loss.frames.at(-1).dropped, true);
});

test('transport rejects invalid options/payload and snapshots are isolated', () => {
  assert.throws(() => new TransportSimulator({ stMinMs: 128 }));
  assert.throws(() => new TransportSimulator({ blockSize: -1 }));
  assert.throws(() => new TransportSimulator({ timeoutMs: 5 }));
  const transport = new TransportSimulator();
  assert.throws(() => transport.start([]));
  assert.throws(() => transport.start([256]));
  transport.start([1, 2]); transport.step();
  transport.getSnapshot().received.push(3);
  assert.deepEqual(transport.received, [1, 2]);
});
