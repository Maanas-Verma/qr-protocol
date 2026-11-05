import QRCode from 'qrcode';
import { Transfer, CHUNK, MAX_SIZE } from './protocol.js';
const $ = id => document.getElementById(id);
const format = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(2)} MiB`;
let file, stream, cameraStarting = false, cameraGeneration = 0, cancelCameraRequest, downloadUrl;
let processing = false, lastScan = '', lastScanTime = 0, cameraTimer, pendingQR, renderedQR, toastTimer, preparing = false, painting = false, lastPaintAt = -Infinity;
let decoder, decodeTask, decodeSeq = 0;
const frame = document.createElement('canvas');
const context = frame.getContext('2d', { willReadFrequently: true });
const terminal = state => ['complete', 'cancelled', 'rejected', 'error'].includes(state);
const labels = { idle: 'Ready', offering: 'Waiting for acceptance', pending: 'Incoming file', sending: 'Streaming', receiving: 'Receiving', verifying: 'Verifying file', complete: 'Complete', cancelled: 'Cancelled', rejected: 'Declined', error: 'Verification failed' };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5500); }
function log(type, message) {
  const logs = $('logs'); logs.querySelector('.log-empty')?.remove();
  const row = document.createElement('div'); row.className = 'log-entry';
  const time = document.createElement('time'); time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const code = document.createElement('code'); code.textContent = type;
  const text = document.createElement('span'); text.textContent = message;
  row.append(time, code, text); logs.prepend(row);
  while (logs.childElementCount > 60) logs.lastChild.remove();
}
const engine = new Transfer({
  emit: raw => { pendingQR = raw; }, change: render, log,
  offer: meta => {
    $('offer-description').textContent = `${meta.name} · ${format(meta.size)} · ${meta.count.toLocaleString()} packets`;
    $('offer-dialog').showModal();
  },
  received: (bytes, meta) => {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    $('download').href = downloadUrl; $('download').download = meta.name || 'received-file'; $('download').hidden = false;
    $('download').click();
    toast('File verified. Download started. Use Save received file if it doesn’t appear.');
  }
});
function render(s) {
  const active = s.state !== 'idle';
  $('file-panel').hidden = active; $('session').hidden = !active;
  $('file-input').disabled = preparing || active;
  $('drop-zone').classList.toggle('busy', preparing || active);
  $('start').disabled = !file || preparing || active;
  $('start').textContent = preparing ? 'Preparing transfer…' : !file ? 'Choose a file to send' : stream ? 'Send file' : 'Enable camera & send file';
  $('transfer-role').textContent = s.role === 'send' ? 'Sending' : s.role === 'receive' ? 'Receiving' : 'Send or receive';
  $('transfer-status').textContent = labels[s.state]; $('transfer-status').classList.toggle('active', active && !terminal(s.state));
  $('cancel').hidden = terminal(s.state); $('reset').hidden = !terminal(s.state);
  $('session-file-name').textContent = s.meta?.name || ''; $('session-file-size').textContent = s.meta ? format(s.meta.size) : '';
  if (s.state !== 'pending' && $('offer-dialog').open) $('offer-dialog').close();
  const qrVisible = Boolean(s.out && renderedQR);
  $('qr').hidden = !qrVisible; $('qr-placeholder').hidden = qrVisible; $('expand').hidden = !qrVisible;
  $('qr-placeholder').textContent = s.state === 'pending' ? 'Waiting for your response…' : terminal(s.state) ? labels[s.state] : 'Preparing QR…';
  const hints = {
    offering: s.conflictingOffer ? 'Both laptops are sending. On one laptop, cancel and choose New transfer to receive instead.' : 'Accept the file on the other laptop. Keep both cameras on.',
    pending: 'Accept or decline the incoming file.',
    sending: 'Streaming packets. Confirmed packets automatically leave the loop.',
    receiving: 'Keep both QR codes in view. The file saves after verification.',
    verifying: 'All packets received. Checking the file before saving.',
    complete: s.role === 'receive' ? 'File verified. Keep this QR visible until the sender also shows Complete.' : 'The other laptop verified the file.',
    cancelled: 'Transfer ended. Start a new transfer on both laptops.',
    rejected: 'File declined. Start a new transfer to try again.',
    error: 'The file could not be verified. Start a new transfer on both laptops.'
  };
  $('session-hint').textContent = active && !stream && !terminal(s.state) ? 'Camera is off. Enable it to continue this transfer.' : hints[s.state] || '';
  const count = s.meta?.count || 0;
  const confirmed = s.confirmedCount;
  const percent = count ? Math.floor(confirmed / count * 100) : 0;
  $('progress').textContent = `${percent}%`;
  document.querySelector('.progress-track').setAttribute('aria-valuenow', percent);
  $('packet-count').textContent = `${confirmed.toLocaleString()} / ${count.toLocaleString()}`;
  $('missing-count').textContent = count ? (count - confirmed).toLocaleString() : '—';
  $('retry-count').textContent = s.retries;
  $('average-interval').textContent = s.averageInterval === null ? '—' : s.averageInterval < 1000 ? `${Math.round(s.averageInterval)} ms` : `${(s.averageInterval / 1000).toFixed(2)} s`;
  $('average-interval').title = s.averageInterval === null ? 'Measured after two distinct packets. Timing adjusts automatically.' : 'Average time between distinct packets displayed (sender) or received (receiver). Timing adjusts automatically.';
  $('progress-bar').style.width = `${percent}%`;
  const grid = $('packet-map'); grid.replaceChildren();
  const group = Math.max(1, Math.ceil(count / 256));
  for (let start = 0; start < count; start += group) {
    const end = Math.min(start + group, count); let got = 0;
    let inFlight = false;
    for (let i = start; i < end; i++) {
      if (s.role === 'receive' ? s.parts.has(i) : s.acknowledged.has(i)) got++;
      else if (s.role === 'send' && s.sent.has(i)) inFlight = true;
    }
    const cell = document.createElement('span'); cell.className = 'packet-cell';
    if (got === end - start) cell.classList.add('confirmed');
    else if (inFlight && s.state === 'sending') cell.classList.add('current');
    cell.title = `Packet${group > 1 ? 's' : ''} ${start + 1}${group > 1 ? `–${end}` : ''}: ${got}/${end - start} confirmed`;
    grid.append(cell);
  }
  if (count) {
    const missing = [];
    for (let i = 0; i < count && missing.length < 12; i++) if (s.role === 'receive' ? !s.parts.has(i) : !s.acknowledged.has(i)) missing.push(i + 1);
    $('missing-detail').textContent = missing.length ? `Pending: ${missing.join(', ')}${count - confirmed > 12 ? ` … (${count - confirmed} total)` : ''}${group > 1 ? ` · ${group} packets/cell` : ''}` : s.state === 'complete' ? 'All packets confirmed. File verified.' : s.state === 'error' ? 'File checksum failed.' : 'All packets received. Verifying…';
  } else $('missing-detail').textContent = 'No active transfer.';
  const captions = { offer: 'File offer', ack: 'Batch acknowledgment', done: 'Completion acknowledgment', finish: 'Waiting for file verification', error: 'File verification failed', cancel: 'Cancellation notice', reject: 'File declined', data: `Streaming packet ${(s.out?.index ?? 0) + 1} of ${count}` };
  $('qr-caption').textContent = captions[s.out?.type] || '';
}
async function paintQR() {
  if (painting || !engine.out || !pendingQR || pendingQR === renderedQR) return;
  const urgent = ['cancel', 'reject'].includes(engine.out.type);
  if (!urgent && Date.now() - lastPaintAt < engine.displayInterval) return;
  painting = true; const raw = pendingQR;
  try {
    await QRCode.toCanvas($('qr'), raw, { width: 720, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#171717ff', light: '#ffffffff' } });
    renderedQR = raw; lastPaintAt = Date.now(); engine.markDisplayed(raw, lastPaintAt);
  } catch (error) { log('ERROR', `Could not display QR: ${error.message}`); }
  finally { painting = false; }
}
function chooseFile(next) {
  if (!next || preparing || engine.state !== 'idle') return;
  if (next.size > MAX_SIZE) { $('file-input').value = ''; toast(`Choose a file up to 5 MiB.${file ? ' Your previous selection is unchanged.' : ''}`); return; }
  file = next; $('file-name').textContent = next.name;
  const count = Math.max(1, Math.ceil(next.size / CHUNK));
  $('file-detail').textContent = `${format(next.size)} · ${count.toLocaleString()} packet${count === 1 ? '' : 's'} · Click to change`;
  render(engine);
}
$('file-input').onchange = event => chooseFile(event.target.files[0]);
$('drop-zone').ondragover = event => { event.preventDefault(); if (!preparing) $('drop-zone').classList.add('dragging'); };
$('drop-zone').ondragleave = () => $('drop-zone').classList.remove('dragging');
$('drop-zone').ondrop = event => {
  event.preventDefault(); $('drop-zone').classList.remove('dragging');
  if (event.dataTransfer.files.length > 1) { toast('Choose one file at a time.'); return; }
  chooseFile(event.dataTransfer.files[0]);
};
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('start').onclick = async () => {
  if (!file || preparing || engine.state !== 'idle') return;
  preparing = true; render(engine);
  try {
    if (!stream && !await startCamera($('camera-select').value)) return;
    if (!stream) return;
    await engine.start(file); await paintQR();
  } catch (error) { toast(error.message); }
  finally { preparing = false; render(engine); }
};
$('accept').onclick = () => { engine.accept(); paintQR(); };
$('reject').onclick = () => { engine.reject(); paintQR(); };
$('offer-dialog').addEventListener('cancel', event => { event.preventDefault(); engine.reject(); paintQR(); });
$('cancel').onclick = () => { engine.cancel(); paintQR(); };
$('reset').onclick = () => {
  pendingQR = renderedQR = null; lastPaintAt = -Infinity; lastScan = ''; lastScanTime = 0;
  $('download').hidden = true;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = null;
  file = null; $('file-input').value = ''; $('file-name').textContent = 'Choose a file'; $('file-detail').textContent = 'or drop it here · Up to 5 MiB'; engine.reset();
};
$('expand').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('.qr-stage').requestFullscreen(); } catch { toast('Fullscreen is unavailable in this browser.'); } };
function cameraUI() {
  $('camera-toggle').hidden = Boolean(stream) || cameraStarting;
  $('stop-camera').hidden = !stream && !cameraStarting;
  $('stop-camera').textContent = cameraStarting ? 'Cancel request' : 'Stop camera';
  $('camera-status').textContent = cameraStarting ? 'Starting…' : stream ? 'Scanning' : 'Off';
  $('camera-status').classList.toggle('active', Boolean(stream));
  $('camera-placeholder').hidden = Boolean(stream);
  $('camera-select').disabled = cameraStarting;
  $('scan-status').textContent = cameraStarting ? 'Allow camera access in your browser. You can cancel while waiting.' : stream ? 'Scanning for the other laptop’s QR code.' : 'Incoming files will ask for your approval.';
  render(engine);
}
function stopCamera() {
  cameraGeneration++; clearTimeout(cameraTimer); cancelCameraRequest?.(); cancelCameraRequest = null;
  stopDecoder();
  cameraStarting = false;
  stream?.getTracks().forEach(track => track.stop()); stream = null; $('video').srcObject = null;
  cameraUI();
}
async function startCamera(deviceId) {
  if (cameraStarting) return false;
  stopCamera(); cameraStarting = true; $('camera-error').hidden = true;
  const generation = cameraGeneration; cameraUI();
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error('Camera access needs HTTPS or localhost. Open this app using a localhost address on each laptop.');
    const cancelled = new Promise(resolve => { cancelCameraRequest = () => resolve(null); });
    const request = navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false }).then(media => {
      if (generation !== cameraGeneration) { media.getTracks().forEach(track => track.stop()); return null; }
      return media;
    });
    const media = await Promise.race([request, cancelled]);
    if (!media || generation !== cameraGeneration) return false;
    cancelCameraRequest = null; stream = media; $('video').srcObject = media; await $('video').play();
    if (generation !== cameraGeneration) return false;
    cameraStarting = false; cameraUI(); log('CAMERA', 'Camera enabled. Scanning for QR codes.'); scan(generation);
    media.getVideoTracks()[0].onended = () => { if (stream === media) { stopCamera(); $('camera-error').textContent = 'Camera disconnected. Reconnect it and enable the camera to continue.'; $('camera-error').hidden = false; } };
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
      if (generation !== cameraGeneration) return false;
      const fallback = document.createElement('option'); fallback.value = ''; fallback.textContent = 'Default camera';
      $('camera-select').replaceChildren(fallback, ...devices.map((device, index) => { const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || `Camera ${index + 1}`; return option; }));
      $('camera-select').value = media.getVideoTracks()[0].getSettings().deviceId || '';
    } catch { /* Scanning still works if device enumeration is unavailable. */ }
    return generation === cameraGeneration && stream === media;
  } catch (error) {
    if (generation !== cameraGeneration) return false;
    stopCamera();
    const message = error.name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access in your browser, then enable the camera again.' : error.name === 'NotFoundError' ? 'No camera found. Connect a webcam, then enable the camera again.' : error.name === 'NotReadableError' ? 'Camera is busy. Close other apps using it, then try again.' : error.name === 'OverconstrainedError' ? 'Selected camera is unavailable. Choose Default camera and try again.' : error.message;
    $('camera-error').textContent = message; $('camera-error').hidden = false; log('CAMERA', message); return false;
  } finally { if (generation === cameraGeneration) { cameraStarting = false; cancelCameraRequest = null; cameraUI(); } }
}
function stopDecoder() {
  decoder?.terminate(); decoder = null;
  if (decodeTask) { const task = decodeTask; decodeTask = null; clearTimeout(task.timeout); task.reject(Error('QR scanner stopped.')); }
}
function decodePixels(pixels) {
  if (!decoder) {
    decoder = new Worker(new URL('./scanner.worker.js', import.meta.url), { type: 'module' });
    decoder.onmessage = ({ data }) => {
      if (!decodeTask || data.id !== decodeTask.id) return;
      const task = decodeTask; decodeTask = null; clearTimeout(task.timeout);
      if (data.error) task.reject(Error(data.error)); else task.resolve(data.text);
    };
    decoder.onerror = event => { event.preventDefault(); stopDecoder(); };
  }
  return new Promise((resolve, reject) => {
    const id = ++decodeSeq;
    const timeout = setTimeout(stopDecoder, 5000);
    decodeTask = { id, resolve, reject, timeout };
    decoder.postMessage({ id, buffer: pixels.data.buffer, width: pixels.width, height: pixels.height }, [pixels.data.buffer]);
  });
}
async function scan(generation) {
  if (!stream || generation !== cameraGeneration) return;
  const video = $('video');
  try {
    if (!processing && video.readyState >= 2 && video.videoWidth) {
      processing = true;
      const scale = Math.min(1, 960 / video.videoWidth);
      frame.width = Math.round(video.videoWidth * scale); frame.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, frame.width, frame.height);
      const pixels = context.getImageData(0, 0, frame.width, frame.height);
      const text = await decodePixels(pixels);
      if (generation !== cameraGeneration || !stream) return;
      if (text && (text !== lastScan || Date.now() - lastScanTime > engine.displayInterval)) {
        lastScan = text; lastScanTime = Date.now(); await engine.ingest(text);
      }
    }
  } catch (error) { if (stream && generation === cameraGeneration) log('SCAN', error.message); }
  finally { processing = false; if (stream && generation === cameraGeneration) cameraTimer = setTimeout(() => scan(generation), 30); }
}
$('camera-toggle').onclick = () => startCamera($('camera-select').value);
$('stop-camera').onclick = stopCamera;
$('camera-select').onchange = () => { if (stream) startCamera($('camera-select').value); };
$('clear-log').onclick = () => { $('logs').replaceChildren(); const empty = document.createElement('p'); empty.className = 'log-empty'; empty.textContent = 'No activity yet.'; $('logs').append(empty); };
setInterval(() => { engine.tick(); paintQR(); }, 25);
window.addEventListener('beforeunload', event => { if (engine.meta && !terminal(engine.state)) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { stream?.getTracks().forEach(track => track.stop()); stopDecoder(); });
