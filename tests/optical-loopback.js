import QRCode from 'qrcode';
import { Transfer, CHUNK } from '../src/protocol.js';
const button = document.getElementById('run'), status = document.getElementById('result');
button.onclick = async () => {
  button.disabled = true;
  const original = Uint8Array.from({ length: CHUNK * 20 + 17 }, (_, i) => i * 29 % 256);
  const dropped = new Set(), channels = [], started = performance.now();
  let sender, receiver, result, stopped = false, clock, timeout, decoded = 0;
  function finish(error) {
    if (stopped) return; stopped = true; clearInterval(clock); clearTimeout(timeout);
    for (const channel of channels) channel.worker.terminate();
    if (error) { status.textContent = `FAIL: ${error.message}`; console.error(error); }
    else status.textContent = `PASS: ${original.length} bytes match exactly; ${receiver.parts.size} packets; ${sender.retries} retransmissions; ${decoded} real worker QR decodes; ${(performance.now() - started).toFixed(0)} ms. Intentionally missed scans recovered. No per-packet ACK wait.`;
    button.disabled = false;
  }
  function channel(canvasId, destination, source) {
    const canvas = document.getElementById(canvasId), worker = new Worker(new URL('../src/scanner.worker.js', import.meta.url), { type: 'module' });
    const state = { worker, pending: null, busy: false, wait: null }; channels.push(state);
    worker.onmessage = ({ data }) => {
      const wait = state.wait; state.wait = null;
      if (data.error) wait?.reject(Error(data.error)); else wait?.resolve(data.text);
    };
    worker.onerror = event => { event.preventDefault(); finish(Error(event.message)); };
    return raw => {
      state.pending = raw;
      if (state.busy || stopped) return;
      state.busy = true;
      (async () => {
        while (state.pending && !stopped) {
          const text = state.pending; state.pending = null;
          await QRCode.toCanvas(canvas, text, { width: 600, margin: 4, errorCorrectionLevel: 'M' });
          source().markDisplayed(text);
          const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
          const data = await new Promise((resolve, reject) => {
            state.wait = { resolve, reject };
            worker.postMessage({ id: ++decoded, buffer: pixels.data.buffer, width: pixels.width, height: pixels.height }, [pixels.data.buffer]);
          });
          if (!data) throw Error('Generated QR could not be decoded');
          if (data !== text) throw Error('QR decoded to the wrong payload');
          const p = JSON.parse(data);
          const key = p.type === 'data' && [3, 13].includes(p.index) ? `data:${p.index}` : p.type === 'ack' && p.seq === 1 ? 'ack:1' : null;
          if (key && !dropped.has(key)) dropped.add(key);
          else await destination().ingest(data);
        }
      })().catch(finish).finally(() => { state.busy = false; });
    };
  }
  const forward = channel('sender', () => receiver, () => sender);
  const back = channel('receiver', () => sender, () => receiver);
  sender = new Transfer({ emit: forward });
  receiver = new Transfer({ emit: back, offer: () => receiver.accept(), received: bytes => { result = bytes; } });
  clock = setInterval(() => {
    sender.tick(); receiver.tick();
    if (sender.state === 'complete') {
      if (!result || result.length !== original.length || result.some((x, i) => x !== original[i])) finish(Error('Reassembled data differs'));
      else if (dropped.size !== 3) finish(Error('Loss scenarios were not exercised'));
      else finish();
    } else if (sender.state === 'error' || receiver.state === 'error') finish(Error('File verification failed'));
    else status.textContent = `Running: ${receiver.parts.size}/${receiver.meta?.count || 0} received; ${sender.confirmedCount} batch-confirmed; ${sender.retries} retries; ${decoded} decoded QRs`;
  }, 25);
  timeout = setTimeout(() => finish(Error('Timed out waiting for optical loopback')), 45000);
  try { await sender.start({ name: 'loopback.bin', type: 'application/octet-stream', size: original.length, arrayBuffer: async () => original.buffer }); }
  catch (error) { finish(error); }
};
