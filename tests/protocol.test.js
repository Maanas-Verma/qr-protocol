import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { Transfer, VERSION, CHUNK, WINDOW, ACK_INTERVAL, MAX_SIZE, crc } from '../src/protocol.js';
const makeFile = (bytes, name = 'hello.bin') => ({ name, type: 'application/octet-stream', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer });
const bytesFor = count => Uint8Array.from({ length: count }, (_, i) => i * 29 % 256);
function link({ latency = 0, paint = true } = {}) {
  let now = 0, sender, receiver, result, downloads = 0, offers = 0;
  const queue = [], history = [];
  const emit = (direction, raw) => {
    const source = direction === 'forward' ? sender : receiver;
    if (paint) source.markDisplayed(raw, now);
    const event = { direction, source, target: direction === 'forward' ? receiver : sender, raw, p: JSON.parse(raw), at: now + latency };
    history.push(event); queue.push(event);
  };
  sender = new Transfer({ now: () => now, emit: raw => emit('forward', raw) });
  receiver = new Transfer({ now: () => now, emit: raw => emit('back', raw), offer: () => offers++, received: bytes => { result = bytes; downloads++; } });
  const state = {
    sender, receiver, queue, history,
    get now() { return now; }, get result() { return result; }, get downloads() { return downloads; }, get offers() { return offers; },
    async flush(capture = () => true) {
      for (let n = 0; n < 2000; n++) {
        queue.sort((a, b) => a.at - b.at);
        if (!queue.length || queue[0].at > now) return;
        const event = queue.shift();
        if (capture(event)) await event.target.ingest(event.raw);
      }
      throw Error('Channel did not quiesce');
    },
    async advance(ms, capture) {
      const until = now + ms;
      while (now < until) { now = Math.min(until, now + 25); sender.tick(); receiver.tick(); await state.flush(capture); }
    },
    async finish(capture, limit = 180000) {
      const until = now + limit;
      while (sender.state !== 'complete' && sender.state !== 'error' && now < until) {
        await state.advance(25, capture);
        if (receiver.state === 'pending') receiver.accept();
      }
      assert.ok(now < until, 'Transfer must not stall');
    }
  };
  return state;
}
async function handshake(p, bytes) {
  await p.sender.start(makeFile(bytes));
  await p.receiver.ingest(p.queue.shift().raw);
  assert.equal(p.receiver.state, 'pending'); assert.equal(p.result, undefined);
  p.receiver.accept(); await p.sender.ingest(p.queue.shift().raw);
  assert.equal(p.sender.state, 'sending'); // The first data frame is queued, not delivered yet.
}
const frames = p => p.history.filter(event => event.p.type === 'data');

test('binary and empty files require acceptance, reassemble, verify, and complete exactly once', async () => {
  for (const size of [0, 1, CHUNK, CHUNK + 1, CHUNK * (WINDOW + 3)]) {
    const p = link(), bytes = bytesFor(size); await handshake(p, bytes); await p.finish();
    assert.equal(p.sender.state, 'complete'); assert.equal(p.receiver.state, 'complete');
    assert.equal(p.sender.confirmedCount, p.sender.meta.count); assert.deepEqual(p.result, bytes); assert.equal(p.downloads, 1);
  }
});
test('multiple data QRs stream before the first batch acknowledgment', async () => {
  const p = link(); await handshake(p, bytesFor(CHUNK * 12));
  await p.advance(ACK_INTERVAL - 25);
  assert.ok(p.sender.sent.size >= 3); assert.ok(p.receiver.parts.size >= 3);
  assert.equal(p.sender.acknowledged.size, 0);
  assert.equal(p.history.filter(event => event.p.type === 'ack').length, 1, 'Only the initial acceptance ACK, not per-packet ACKs');
  await p.advance(50); assert.ok(p.sender.confirmedCount >= 3);
  await p.finish(); assert.equal(p.sender.state, 'complete');
});
test('without feedback, sender loops within a bounded window instead of waiting on one packet', async () => {
  const p = link(); await handshake(p, bytesFor(CHUNK * WINDOW * 3));
  await p.advance(22000, () => false);
  assert.equal(p.sender.sent.size, WINDOW); assert.ok(frames(p).length > WINDOW);
  assert.ok(frames(p).every(event => event.p.index < WINDOW)); assert.ok(p.sender.retries > 0);
  assert.ok(p.sender.displayInterval > 180, 'No feedback automatically slows the stream');
});
test('selective batch reports preserve out-of-order packets and remove them from the streaming loop', async () => {
  const p = link(); await handshake(p, bytesFor(CHUNK * 8));
  await p.advance(800, () => false);
  const first = frames(p);
  for (const index of [4, 2, 0]) await p.receiver.ingest(first.find(event => event.p.index === index).raw);
  assert.equal(p.receiver.next, 1); assert.equal(p.receiver.parts.size, 3);
  p.queue.length = 0; p.receiver.tick();
  const report = p.queue.shift(); assert.equal(report.p.base, 1); assert.equal(report.p.seen, '0a000000');
  await p.sender.ingest(report.raw);
  assert.deepEqual([...p.sender.acknowledged].sort((a, b) => a - b), [0, 2, 4]);
  const cutoff = p.history.length;
  await p.advance(3000, () => false);
  const later = p.history.slice(cutoff).filter(event => event.p.type === 'data');
  assert.ok(later.some(event => event.p.index === 1)); assert.ok(later.some(event => event.p.index === 3));
  assert.ok(later.every(event => ![0, 2, 4].includes(event.p.index)), 'Confirmed packets must leave the loop');
});
test('loss at every handshake stage, missing data, and lost final confirmation all recover', async () => {
  const p = link(), bytes = bytesFor(CHUNK * (WINDOW + 9)); const dropped = new Set();
  const capture = event => {
    const key = `${event.p.type}:${event.p.type === 'data' ? event.p.index : event.p.type === 'ack' ? event.p.base : ''}`;
    if (!dropped.has(key)) { dropped.add(key); return false; }
    return true;
  };
  // Drop every first data attempt and the first report for every cumulative base.
  await p.sender.start(makeFile(bytes)); await p.finish(capture);
  assert.equal(p.sender.state, 'complete'); assert.deepEqual(p.result, bytes); assert.equal(p.downloads, 1);
});
test('stale and duplicate ACKs never regress progress or restore confirmed packets', async () => {
  const p = link(); await handshake(p, bytesFor(CHUNK * 15)); await p.advance(1300);
  const reports = p.history.filter(event => event.p.type === 'ack'); assert.ok(reports.length >= 3);
  const confirmed = p.sender.confirmedCount, base = p.sender.next, interval = p.sender.displayInterval;
  for (const report of reports.reverse()) { await p.sender.ingest(report.raw); await p.sender.ingest(report.raw); }
  assert.equal(p.sender.confirmedCount, confirmed); assert.equal(p.sender.next, base); assert.equal(p.sender.displayInterval, interval);
  await p.finish();
});
test('CRC corruption is retried and valid duplicate data does not duplicate bytes or timing samples', async () => {
  const p = link(), bytes = bytesFor(CHUNK * 5); await handshake(p, bytes);
  const first = p.queue.shift(); const damaged = { ...first.p, crc: 'bad' };
  await p.receiver.ingest(JSON.stringify(damaged)); assert.equal(p.receiver.parts.size, 0);
  await p.receiver.ingest(first.raw); await p.receiver.ingest(first.raw);
  assert.equal(p.receiver.parts.size, 1); assert.equal(p.receiver.intervalSamples, 0);
  await p.finish(); assert.deepEqual(p.result, bytes); assert.equal(p.downloads, 1);
});
test('whole-file SHA-256 failure propagates to the sender without saving a file', async () => {
  const p = link(); await handshake(p, new Uint8Array(1));
  const first = p.queue.shift(); const bytes = new Uint8Array([120]);
  await p.receiver.ingest(JSON.stringify({ ...first.p, data: btoa('x'), crc: crc(bytes) }));
  await p.flush();
  assert.equal(p.receiver.state, 'error'); assert.equal(p.sender.state, 'error'); assert.equal(p.result, undefined);
});
test('invalid metadata, oversized files, old protocol versions, wrong sessions, and impossible ACKs are ignored', async () => {
  const p = link();
  for (const input of ['not json', 'null', '{}', JSON.stringify({ v: VERSION, id: 'a', type: 'offer', size: MAX_SIZE + 1, count: 1, name: 'x', hash: 'a'.repeat(64), mime: '' })]) await p.receiver.ingest(input);
  assert.equal(p.receiver.state, 'idle');
  await assert.rejects(p.sender.start({ size: MAX_SIZE + 1 }), /5 MiB/);
  await handshake(p, bytesFor(CHUNK * 5));
  const valid = { v: VERSION, id: p.sender.meta.id, type: 'ack', base: 1, seen: '00000000', seq: 1, through: 1 };
  for (const fields of [{ v: 1 }, { id: 'wrong' }, { base: 5 }, { base: -1 }, { base: 0, seen: '01000000' }, { base: 0, seen: '10000000' }, { seen: 'bad' }, { seq: 1.5 }, { through: 999 }]) await p.sender.ingest(JSON.stringify({ ...valid, ...fields }));
  assert.equal(p.sender.confirmedCount, 0);
  const prematureDone = { v: VERSION, id: p.sender.meta.id, type: 'done', hash: p.sender.meta.hash };
  await p.sender.ingest(JSON.stringify(prematureDone)); assert.equal(p.sender.state, 'sending');
  // Packet indexes outside the bounded receiver window cannot allocate storage.
  const first = p.queue[0].p;
  await p.receiver.ingest(JSON.stringify({ ...first, index: WINDOW + 1 })); assert.equal(p.receiver.parts.size, 0);
});
test('decline and cancellation end matching sessions', async () => {
  for (const action of ['reject', 'cancel']) {
    const p = link(); await p.sender.start(makeFile(new Uint8Array(800))); await p.flush(); p.receiver[action](); await p.flush();
    assert.equal(p.sender.state, action === 'reject' ? 'rejected' : 'cancelled'); assert.equal(p.result, undefined);
  }
  const p = link(); await handshake(p, bytesFor(CHUNK * 5)); p.sender.cancel(); await p.flush();
  assert.equal(p.receiver.state, 'cancelled');
});
test('a queued QR must be painted before another frame can replace it', async () => {
  const p = link({ paint: false }); await handshake(p, bytesFor(CHUNK * 4));
  const first = p.queue[0].raw; await p.advance(1000, () => false);
  assert.equal(frames(p).length, 1); assert.equal(p.sender.averageInterval, null);
  p.sender.markDisplayed(first, p.now); await p.advance(p.sender.displayInterval, () => false);
  assert.equal(frames(p).length, 2);
  p.sender.markDisplayed(first, p.now); assert.equal(p.sender.displayPending, true, 'An obsolete paint cannot release the new frame');
  const second = frames(p)[1].raw; p.sender.markDisplayed(second, p.now);
  assert.equal(p.sender.averageInterval, p.sender.displayInterval);
  p.sender.markDisplayed(second, p.now); assert.equal(p.sender.intervalSamples, 1);
  p.sender.reset(); assert.equal(p.sender.averageInterval, null);
});
test('batch capture feedback speeds a reliable channel and slows a lossy channel within bounds', async () => {
  for (const lossy of [false, true]) {
    const p = link(); await handshake(p, bytesFor(CHUNK * 100));
    const capture = event => event.p.type !== 'data' || !lossy || event.p.seq % 3 === 0;
    await p.advance(5000, capture);
    assert.ok(lossy ? p.sender.displayInterval > 180 : p.sender.displayInterval < 180);
    assert.ok(p.sender.displayInterval >= 100 && p.sender.displayInterval <= 1000);
  }
});
test('delayed feedback can stream much faster than stop-and-wait under a simulated 800 ms round trip', async t => {
  const count = 80, latency = 400, p = link({ latency });
  await p.sender.start(makeFile(bytesFor(CHUNK * count))); await p.finish();
  assert.equal(p.sender.state, 'complete');
  const stopAndWaitLowerBound = count * latency * 2;
  assert.ok(p.now < stopAndWaitLowerBound / 2, `Streaming ${p.now} ms vs stop-and-wait lower bound ${stopAndWaitLowerBound} ms`);
  t.diagnostic(`Simulated streaming: ${p.now} ms; stop-and-wait RTT-only lower bound: ${stopAndWaitLowerBound} ms. This is not a camera benchmark.`);
});
function decodeQR(raw) {
  const qr = QRCode.create(raw, { errorCorrectionLevel: 'M' }); const scale = 6, margin = 4, width = (qr.modules.size + margin * 2) * scale;
  const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const row = Math.floor(y / scale) - margin, col = Math.floor(x / scale) - margin;
    if (row >= 0 && col >= 0 && row < qr.modules.size && col < qr.modules.size && qr.modules.get(row, col)) {
      const offset = (y * width + x) * 4; rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 0;
    }
  }
  return jsQR(rgba, width, width)?.data;
}
test('full-size streamed packet and compact batch ACK round trip through real QR libraries', async () => {
  const p = link(); await handshake(p, bytesFor(CHUNK * 3)); const raw = p.queue.shift().raw;
  assert.equal(decodeQR(raw), raw); await p.receiver.ingest(decodeQR(raw));
  await p.advance(ACK_INTERVAL, () => false);
  const report = p.history.filter(event => event.p.type === 'ack').at(-1).raw;
  assert.equal(decodeQR(report), report); await p.sender.ingest(decodeQR(report));
  assert.equal(p.sender.confirmedCount, 1); await p.finish(); assert.equal(p.sender.state, 'complete');
});
test('simultaneous offers remain recoverable without overwriting a file', async () => {
  const p = link(), bytes = new Uint8Array([1, 2, 3]);
  await p.sender.start(makeFile(bytes)); await p.receiver.start(makeFile(new Uint8Array([4]))); await p.flush();
  assert.equal(p.sender.conflictingOffer, true); assert.equal(p.receiver.conflictingOffer, true);
  p.receiver.cancel(); await p.flush(); p.receiver.reset(); await p.finish();
  assert.equal(p.sender.state, 'complete'); assert.deepEqual(p.result, bytes);
});
