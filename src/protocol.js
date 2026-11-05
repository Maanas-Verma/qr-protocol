export const VERSION = 2;
export const CHUNK = 384;
export const WINDOW = 32;
export const ACK_INTERVAL = 600;
export const MAX_SIZE = 5 * 1024 * 1024;
export const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
export const encode = bytes => btoa(String.fromCharCode(...bytes));
export const decode = text => Uint8Array.from(atob(text), x => x.charCodeAt(0));
export function crc(bytes) {
  let value = -1;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); }
  return ((value ^ -1) >>> 0).toString(16);
}
const packet = (id, type, fields = {}) => ({ v: VERSION, id, type, ...fields });
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const terminal = state => ['complete', 'rejected', 'cancelled', 'error'].includes(state);
export class Transfer {
  constructor({ emit, change = () => {}, offer = () => {}, received = () => {}, log = () => {}, now = () => Date.now() }) {
    Object.assign(this, { emit, change, offer, received, log, now }); this.reset();
  }
  reset() {
    this.state = 'idle'; this.role = null; this.meta = null; this.bytes = null; this.parts = new Map();
    this.acknowledged = new Set(); this.sent = new Set(); this.transmissions = new Map();
    this.next = 0; this.cursor = 0; this.frameSeq = 0; this.maxFrame = 0;
    this.retries = 0; this.out = null; this.last = 0; this.lastDisplayed = 0; this.displayPending = false;
    this.displayInterval = 180; this.retryDelay = 1800; this.retryAttempts = 0;
    this.lastFeedback = 0; this.lastSlowdown = 0; this.lastAckSeq = -1; this.ackSeq = 0;
    this.lastTunedSeq = 0; this.feedbackAttempts = 0; this.feedbackConfirmed = 0;
    this.ackDirty = false; this.lastAckAt = 0; this.lastPacketAt = null;
    this.intervalTotal = 0; this.intervalSamples = 0; this.averageInterval = null;
    this.measuredIndexes = new Set(); this.conflictingOffer = false;
    this.change(this);
  }
  get confirmedCount() { return this.role === 'receive' ? this.parts.size : this.acknowledged.size; }
  publish(p) {
    this.out = p; this.last = this.now(); this.displayPending = true; this.retryAttempts = 0;
    this.emit(JSON.stringify(p)); this.change(this);
  }
  recordPacketTime(index, now) {
    if (this.measuredIndexes.has(index)) return;
    this.measuredIndexes.add(index);
    if (this.lastPacketAt !== null) {
      this.intervalTotal += Math.max(0, now - this.lastPacketAt); this.intervalSamples++;
      this.averageInterval = this.intervalTotal / this.intervalSamples;
    }
    this.lastPacketAt = now;
  }
  // The stream cannot replace a queued frame until the browser paints it.
  markDisplayed(raw, now = this.now()) {
    if (!this.out || JSON.stringify(this.out) !== raw || !this.displayPending) return;
    this.displayPending = false; this.lastDisplayed = now; this.last = now;
    if (this.out.type === 'data') {
      this.recordPacketTime(this.out.index, now);
      this.transmissions.set(this.out.seq, { index: this.out.index, at: now });
      if (this.transmissions.size > 2048) this.transmissions.delete(this.transmissions.keys().next().value);
    }
    this.change(this);
  }
  async start(file) {
    if (this.state !== 'idle' && !terminal(this.state)) throw Error('Finish or cancel the current transfer first.');
    if (file.size > MAX_SIZE) throw Error('Choose a file up to 5 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await digest(bytes);
    if (this.state !== 'idle' && !terminal(this.state)) throw Error('An incoming offer arrived. Accept or decline it first.');
    this.reset(); this.role = 'send'; this.bytes = bytes;
    this.meta = { id: crypto.randomUUID(), name: file.name.slice(0, 180), size: bytes.length, mime: file.type.slice(0, 100), count: Math.max(1, Math.ceil(bytes.length / CHUNK)), hash };
    this.state = 'offering'; this.log('OFFER', 'File offer is on screen. Waiting for acceptance.');
    this.publish(packet(this.meta.id, 'offer', this.meta));
  }
  accept() {
    if (this.state !== 'pending') return;
    this.state = 'receiving'; this.displayInterval = 100;
    this.log('ACCEPT', 'Accepted file. Receiving a packet stream.'); this.publishAck();
  }
  publishAck() {
    const bits = new Uint8Array(WINDOW / 8);
    for (let offset = 0; offset < WINDOW; offset++) if (this.parts.has(this.next + offset)) bits[offset >> 3] |= 1 << (offset & 7);
    const seen = [...bits].map(x => x.toString(16).padStart(2, '0')).join('');
    this.lastAckAt = this.now(); this.ackDirty = false;
    this.publish(packet(this.meta.id, 'ack', { base: this.next, seen, seq: this.ackSeq++, through: this.maxFrame }));
  }
  reject() { if (this.state !== 'pending') return; this.state = 'rejected'; this.publish(packet(this.meta.id, 'reject')); }
  cancel() { if (!this.meta || terminal(this.state)) return; this.state = 'cancelled'; this.log('CANCEL', 'Transfer cancelled.'); this.publish(packet(this.meta.id, 'cancel')); }
  sendNext() {
    if (this.acknowledged.size === this.meta.count) {
      this.publish(packet(this.meta.id, 'finish')); return;
    }
    const end = Math.min(this.next + WINDOW, this.meta.count);
    if (this.cursor < this.next || this.cursor >= end) this.cursor = this.next;
    for (let attempts = 0; attempts < end - this.next; attempts++) {
      const index = this.cursor++;
      if (this.cursor >= end) this.cursor = this.next;
      if (this.acknowledged.has(index)) continue;
      if (this.sent.has(index)) {
        this.retries++;
        if (this.retries % WINDOW === 1) this.log('RETRY', 'Looping through packets not yet confirmed by the receiver.');
      }
      this.sent.add(index);
      const bytes = this.bytes.slice(index * CHUNK, (index + 1) * CHUNK);
      this.publish(packet(this.meta.id, 'data', { index, seq: ++this.frameSeq, data: encode(bytes), crc: crc(bytes) }));
      return;
    }
  }
  tick(now = this.now()) {
    if (!this.out || this.state === 'pending') return;
    if (this.state === 'sending' && this.out.type === 'data') {
      if (now - Math.max(this.lastFeedback, this.lastSlowdown) >= 3000) {
        this.displayInterval = Math.round(clamp(this.displayInterval * 1.25, 100, 1000)); this.lastSlowdown = now;
      }
      if (!this.displayPending && now - this.lastDisplayed >= this.displayInterval) this.sendNext();
      return;
    }
    if (this.state === 'receiving' && this.ackDirty && now - this.lastAckAt >= ACK_INTERVAL) { this.publishAck(); return; }
    // Static control frames remain on screen and repeat until their peer progresses.
    const delay = Math.min(10000, this.retryDelay * 1.5 ** this.retryAttempts);
    if (now - this.last >= delay) {
      this.retryAttempts = Math.min(10, this.retryAttempts + 1);
      this.last = now; this.emit(JSON.stringify(this.out));
    }
  }
  applyAck(p) {
    if (!Number.isInteger(p.base) || p.base < 0 || p.base > this.meta.count || typeof p.seen !== 'string' || !/^[a-f0-9]{8}$/.test(p.seen) || !Number.isSafeInteger(p.seq) || p.seq < 0 || p.seq <= this.lastAckSeq || !Number.isSafeInteger(p.through) || p.through < 0 || p.through > this.frameSeq) return;
    const bits = Uint8Array.from(p.seen.match(/../g), hex => parseInt(hex, 16));
    if (bits[0] & 1) return; // base is the first missing index, never a received one.
    const claims = [];
    for (let i = this.next; i < p.base; i++) { if (!this.sent.has(i)) return; if (!this.acknowledged.has(i)) claims.push(i); }
    for (let offset = 0; offset < WINDOW; offset++) {
      if (!(bits[offset >> 3] & (1 << (offset & 7)))) continue;
      const index = p.base + offset;
      if (index >= this.meta.count || !this.sent.has(index)) return;
      if (!this.acknowledged.has(index)) claims.push(index);
    }
    if (this.state === 'offering') {
      if (p.base !== 0 || p.seen !== '00000000' || p.through !== 0) return;
      this.state = 'sending'; this.lastAckSeq = p.seq; this.lastFeedback = this.now();
      this.log('ACCEPT', `Receiver accepted. Streaming up to ${WINDOW} unconfirmed packets.`); this.sendNext(); return;
    }
    this.lastAckSeq = p.seq; this.lastFeedback = this.now();
    for (const index of claims) this.acknowledged.add(index);
    while (this.acknowledged.has(this.next)) this.next++;
    // Batch feedback tunes capture rate without confusing the 600 ms ACK delay with camera speed.
    let attempts = 0;
    for (const [seq] of this.transmissions) if (seq > this.lastTunedSeq && seq <= p.through) { attempts++; this.transmissions.delete(seq); }
    this.lastTunedSeq = Math.max(this.lastTunedSeq, p.through);
    this.feedbackAttempts += attempts; this.feedbackConfirmed += claims.length;
    if (this.feedbackAttempts >= 8) {
      const captured = this.feedbackConfirmed / this.feedbackAttempts;
      if (captured >= .85) this.displayInterval = Math.round(clamp(this.displayInterval * .9, 100, 1000));
      else if (captured < .55) this.displayInterval = Math.round(clamp(this.displayInterval * 1.25, 100, 1000));
      this.feedbackAttempts = 0; this.feedbackConfirmed = 0;
    }
    this.change(this);
  }
  async ingest(raw) {
    let p; try { if (typeof raw !== 'string' || raw.length > 2500) return; p = JSON.parse(raw); } catch { return; }
    if (!p || p.v !== VERSION || typeof p.id !== 'string' || p.id.length > 80) return;
    if (p.type === 'offer') {
      if (this.meta?.id === p.id) { if (this.out && this.state !== 'pending') this.emit(JSON.stringify(this.out)); return; }
      if (typeof p.name !== 'string' || p.name.length > 180 || typeof p.mime !== 'string' || p.mime.length > 100 || !Number.isInteger(p.size) || p.size < 0 || p.size > MAX_SIZE || p.count !== Math.max(1, Math.ceil(p.size / CHUNK)) || !/^[a-f0-9]{64}$/.test(p.hash)) return;
      if (this.state !== 'idle') {
        if (this.state === 'offering' && !this.conflictingOffer) {
          this.conflictingOffer = true; this.log('BUSY', 'Both laptops are sending. On one laptop, cancel and choose New transfer to receive instead.'); this.change(this);
        }
        return;
      }
      this.meta = { id: p.id, name: p.name, mime: p.mime, size: p.size, count: p.count, hash: p.hash };
      this.role = 'receive'; this.state = 'pending'; this.log('OFFER', `Incoming file: ${p.name}`); this.change(this); this.offer(this.meta); return;
    }
    if (!this.meta || p.id !== this.meta.id) return;
    if (['cancel', 'reject', 'error'].includes(p.type)) {
      if (terminal(this.state)) return;
      this.state = p.type === 'cancel' ? 'cancelled' : p.type === 'reject' ? 'rejected' : 'error'; this.out = null;
      this.log(p.type.toUpperCase(), p.type === 'error' ? 'The receiver could not verify the file. Start a new transfer.' : 'The other laptop ended this transfer.'); this.change(this); return;
    }
    if (this.role === 'send') {
      if (this.state === 'sending' && p.type === 'done' && this.sent.size === this.meta.count && p.hash === this.meta.hash) {
        for (let i = 0; i < this.meta.count; i++) this.acknowledged.add(i);
        this.next = this.meta.count; this.state = 'complete'; this.out = null;
        this.log('DONE', 'Receiver verified the complete file.'); this.change(this); return;
      }
      if (p.type === 'ack' && ['offering', 'sending'].includes(this.state)) this.applyAck(p);
      return;
    }
    if (p.type === 'finish' && ['receiving', 'complete', 'verifying'].includes(this.state)) {
      if (this.state === 'receiving') this.publishAck(); else if (this.out) this.emit(JSON.stringify(this.out)); return;
    }
    if (p.type !== 'data' || !['receiving', 'complete', 'verifying', 'error'].includes(this.state)) return;
    if (['complete', 'verifying', 'error'].includes(this.state)) { if (this.out) this.emit(JSON.stringify(this.out)); return; }
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= Math.min(this.meta.count, this.next + WINDOW) || !Number.isSafeInteger(p.seq) || p.seq < 1 || typeof p.data !== 'string' || p.data.length > 512) return;
    let bytes; try { bytes = decode(p.data); } catch { return; }
    if (bytes.length !== Math.min(CHUNK, Math.max(0, this.meta.size - p.index * CHUNK)) || crc(bytes) !== p.crc) return;
    this.maxFrame = Math.max(this.maxFrame, p.seq); this.ackDirty = true;
    if (!this.parts.has(p.index)) { this.recordPacketTime(p.index, this.now()); this.parts.set(p.index, bytes); }
    while (this.parts.has(this.next)) this.next++;
    if (this.parts.size === this.meta.count) {
      this.state = 'verifying'; this.publishAck();
      const result = new Uint8Array(this.meta.size);
      for (const [index, part] of this.parts) result.set(part, index * CHUNK);
      const id = this.meta.id; const hash = await digest(result);
      if (this.meta?.id !== id || this.state !== 'verifying') return;
      if (hash !== this.meta.hash) { this.state = 'error'; this.log('ERROR', 'File checksum failed. Start a new transfer.'); this.publish(packet(id, 'error')); return; }
      this.state = 'complete'; this.log('DONE', 'SHA-256 verified. Your file is ready to save.');
      this.publish(packet(id, 'done', { hash })); this.received(result, this.meta); return;
    }
    this.change(this);
  }
}
