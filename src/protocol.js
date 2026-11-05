export const CHUNK = 384;
export const MAX_SIZE = 5 * 1024 * 1024;
export const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
export const encode = bytes => btoa(String.fromCharCode(...bytes));
export const decode = text => Uint8Array.from(atob(text), x => x.charCodeAt(0));
export function crc(bytes) {
  let value = -1;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); }
  return ((value ^ -1) >>> 0).toString(16);
}
const packet = (id, type, fields = {}) => ({ v: 1, id, type, ...fields });
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export class Transfer {
  constructor({ emit, change = () => {}, offer = () => {}, received = () => {}, log = () => {}, now = () => Date.now() }) {
    Object.assign(this, { emit, change, offer, received, log, now }); this.reset();
  }
  reset() {
    this.state = 'idle'; this.role = null; this.meta = null; this.bytes = null; this.parts = new Map();
    this.next = 0; this.retries = 0; this.out = null; this.last = 0;
    this.displayInterval = 300; this.retryDelay = 1800; this.retryAttempts = 0; this.smoothedRtt = null;
    this.sentAt = null; this.displayedIndex = -1; this.lastPacketAt = null;
    this.conflictingOffer = false;
    this.intervalTotal = 0; this.intervalSamples = 0; this.averageInterval = null;
    this.change(this);
  }
  publish(p) { this.out = p; this.last = this.now(); this.retryAttempts = 0; this.emit(JSON.stringify(p)); this.change(this); }
  recordPacketTime(now) {
    if (this.lastPacketAt !== null) {
      this.intervalTotal += Math.max(0, now - this.lastPacketAt); this.intervalSamples++;
      this.averageInterval = this.intervalTotal / this.intervalSamples;
    }
    this.lastPacketAt = now;
  }
  // Called only after the browser actually paints a new QR, not when it queues one.
  markDisplayed(raw, now = this.now()) {
    if (!this.out || JSON.stringify(this.out) !== raw) return;
    this.last = now;
    if (this.out.type === 'data' && this.displayedIndex !== this.out.index) {
      this.displayedIndex = this.out.index; this.sentAt = now; this.recordPacketTime(now); this.change(this);
    }
  }
  observeAcknowledgment() {
    if (this.sentAt === null) return;
    const sample = clamp(this.now() - this.sentAt, 50, 30000);
    this.smoothedRtt = this.smoothedRtt === null ? sample : this.smoothedRtt * .8 + sample * .2;
    this.displayInterval = Math.round(clamp(this.smoothedRtt * .35, 150, 1200));
    this.retryDelay = Math.round(clamp(this.smoothedRtt * 2.5 + 200, 900, 10000));
    this.sentAt = null;
  }
  async start(file) {
    if (!['idle', 'complete', 'cancelled', 'rejected', 'error'].includes(this.state)) throw Error('Finish or cancel the current transfer first.');
    if (file.size > MAX_SIZE) throw Error('Choose a file smaller than 5 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await digest(bytes);
    if (!['idle', 'complete', 'cancelled', 'rejected', 'error'].includes(this.state)) throw Error('An incoming offer arrived. Accept or decline it first.');
    this.reset(); this.role = 'send'; this.bytes = bytes;
    this.meta = { id: crypto.randomUUID(), name: file.name.slice(0, 180), size: bytes.length, mime: file.type.slice(0, 100), count: Math.max(1, Math.ceil(bytes.length / CHUNK)), hash };
    this.state = 'offering'; this.log('OFFER', 'File offer is on screen. Waiting for acceptance.');
    this.publish(packet(this.meta.id, 'offer', this.meta));
  }
  accept() {
    if (this.state !== 'pending') return;
    this.state = 'receiving'; this.log('ACCEPT', 'Accepted file. Ready for packet 1.');
    this.publish(packet(this.meta.id, 'ack', { next: 0 }));
  }
  reject() { if (this.state !== 'pending') return; this.state = 'rejected'; this.publish(packet(this.meta.id, 'reject')); }
  cancel() { if (!this.meta || ['idle', 'complete', 'rejected', 'cancelled'].includes(this.state)) return; this.state = 'cancelled'; this.log('CANCEL', 'Transfer cancelled.'); this.publish(packet(this.meta.id, 'cancel')); }
  sendPart() {
    this.state = 'sending'; const bytes = this.bytes.slice(this.next * CHUNK, (this.next + 1) * CHUNK);
    this.sentAt = this.now();
    this.publish(packet(this.meta.id, 'data', { index: this.next, data: encode(bytes), crc: crc(bytes) }));
  }
  tick(now = this.now()) {
    if (!this.out || this.state === 'pending' || this.state === 'error') return;
    const delay = Math.min(10000, this.retryDelay * 1.5 ** this.retryAttempts);
    if (now - this.last >= delay) {
      this.retryAttempts = Math.min(10, this.retryAttempts + 1);
      if (['sending', 'offering'].includes(this.state)) { this.retries++; if (this.retries % 10 === 1) this.log('RETRY', 'Repeating QR while waiting for the other camera.'); }
      this.last = now; this.emit(JSON.stringify(this.out)); this.change(this);
    }
  }
  async ingest(raw) {
    let p; try { if (raw.length > 2500) return; p = JSON.parse(raw); } catch { return; }
    if (!p || p.v !== 1 || typeof p.id !== 'string' || p.id.length > 80) return;
    if (p.type === 'offer') {
      if (this.meta?.id === p.id) { if (this.out && this.state !== 'pending') this.emit(JSON.stringify(this.out)); return; }
      if (typeof p.name !== 'string' || p.name.length > 180 || typeof p.mime !== 'string' || p.mime.length > 100 || !Number.isInteger(p.size) || p.size < 0 || p.size > MAX_SIZE || p.count !== Math.max(1, Math.ceil(p.size / CHUNK)) || !/^[a-f0-9]{64}$/.test(p.hash)) return;
      if (this.state !== 'idle') {
        if (this.state === 'offering' && !this.conflictingOffer) {
          this.conflictingOffer = true;
          this.log('BUSY', 'Both laptops are sending. On one laptop, cancel and choose New transfer to receive instead.');
          this.change(this);
        }
        return;
      }
      this.meta = { id: p.id, name: p.name, mime: p.mime, size: p.size, count: p.count, hash: p.hash };
      this.role = 'receive'; this.state = 'pending'; this.log('OFFER', `Incoming file: ${p.name}`); this.change(this); this.offer(this.meta); return;
    }
    if (!this.meta || p.id !== this.meta.id) return;
    if (['cancel', 'reject'].includes(p.type)) {
      if (['complete', 'cancelled', 'rejected', 'error'].includes(this.state)) return;
      this.state = p.type === 'cancel' ? 'cancelled' : 'rejected'; this.out = null; this.log(p.type.toUpperCase(), 'The other laptop ended this transfer.'); this.change(this); return;
    }
    if (this.role === 'send') {
      if (p.type === 'done' && this.state === 'sending' && this.next === this.meta.count - 1 && p.hash === this.meta.hash) {
        this.observeAcknowledgment();
        this.next = this.meta.count; this.state = 'complete'; this.out = null; this.log('DONE', 'Receiver verified the complete file.'); this.change(this); return;
      }
      if (p.type !== 'ack' || !Number.isInteger(p.next)) return;
      if (this.state === 'offering' && p.next === 0) { this.log('ACCEPT', 'Receiver accepted. Sending packets.'); this.sendPart(); }
      else if (this.state === 'sending' && p.next === this.next + 1 && p.next < this.meta.count) { this.observeAcknowledgment(); this.next = p.next; this.sendPart(); }
      return;
    }
    if (p.type !== 'data' || !['receiving', 'complete', 'verifying'].includes(this.state)) return;
    if (this.state === 'complete') { this.emit(JSON.stringify(this.out)); return; }
    if (this.state === 'verifying') return;
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= this.meta.count || typeof p.data !== 'string' || p.data.length > 512) return;
    let bytes; try { bytes = decode(p.data); } catch { return; }
    if (bytes.length !== Math.min(CHUNK, Math.max(0, this.meta.size - p.index * CHUNK)) || crc(bytes) !== p.crc) return;
    if (!this.parts.has(p.index)) {
      this.recordPacketTime(this.now());
      if (this.averageInterval !== null) {
        this.displayInterval = Math.round(clamp(this.averageInterval * .2, 150, 1200));
        this.retryDelay = Math.round(clamp(this.averageInterval * 2.5, 900, 10000));
      }
      this.parts.set(p.index, bytes);
    }
    while (this.parts.has(this.next)) this.next++;
    if (this.parts.size === this.meta.count) {
      this.state = 'verifying'; this.change(this);
      const result = new Uint8Array(this.meta.size);
      for (const [index, part] of this.parts) result.set(part, index * CHUNK);
      const id = this.meta.id; const hash = await digest(result);
      if (this.meta?.id !== id || this.state !== 'verifying') return;
      if (hash !== this.meta.hash) { this.state = 'error'; this.out = null; this.log('ERROR', 'File checksum failed. Start a new transfer.'); this.change(this); return; }
      this.state = 'complete'; this.log('DONE', 'SHA-256 verified. Your file is ready to save.');
      this.publish(packet(id, 'done', { hash })); this.received(result, this.meta); return;
    }
    this.publish(packet(this.meta.id, 'ack', { next: this.next }));
  }
}
