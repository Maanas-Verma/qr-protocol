# Lumen · QR Transfer Protocol (QRTP/1)

A plain HTML, CSS, and JavaScript application that transfers files between two laptops using their screens and cameras. File bytes travel in QR codes; no WebRTC, sockets, remote storage, or file-upload server is involved. Vite serves and bundles the app, `qrcode` generates codes, and `jsqr` decodes camera frames. Both QR libraries are bundled locally.

## Run on both laptops

Requires Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev
```

Open the printed localhost URL on **each** laptop. Each laptop runs its own copy; they do not need to share Wi-Fi. Internet is needed for the initial dependency installation. The app uses system fonts and has no external asset requests after installation.

For a production bundle:

```sh
npm run build
npm run preview
```

The `dist/` directory can also be served by any static HTTPS server. Do not simply open `index.html` using `file://`. Camera access requires localhost or HTTPS; serving over a plain HTTP LAN IP generally will not work.

## Transfer a file

1. Enable the cameras on both laptops and grant camera access. Choose another input device if needed.
2. Position both laptops so **each camera sees the other laptop's QR code**. Angle the screens or use external webcams if the built-in camera fields of view do not line up.
3. Sender: choose a file and click **Send file** (or **Enable camera & send file** if the camera is off).
4. Receiver: enable the camera and accept the incoming file prompt. There are no modes to select.
5. Keep both camera views unobstructed and both browser tabs visible. Use **Enlarge QR** for a larger QR code if decoding is unreliable; press Escape to leave fullscreen.
6. After all packets arrive and SHA-256 verification passes, the receiver initiates a browser download. The **Save received file** button remains available as a fallback. The browser controls the download location and any save prompt.
7. Click **New transfer** on both laptops before the next file. Reloading clears all transfer state.

Start with a tiny text file. Optical transfers are slow: the stop-and-wait protocol sends 384 bytes per acknowledged packet, and files approaching 5 MiB can take hours. Display timing adjusts automatically; there is no manual speed setting.

### Automatic timing

The initial minimum QR hold is 300 ms. After each valid data acknowledgment, the sender measures the round-trip latency from the actual QR paint, smooths it with an exponential average (80% previous, 20% new), and adjusts the minimum hold to 35% of that latency, bounded to 150–1200 ms. The receiver independently adjusts its acknowledgment display cadence using observed intervals between distinct valid packets. Both sides retain the current code until the protocol produces the next frame; no packets are skipped to hit a frame rate.

The retry timeout starts at 1800 ms and adapts to observed latency, bounded to 900–10000 ms. Consecutive retries back off by 1.5×, capped at 10 seconds. Scanner duplicate suppression follows the automatic hold interval.

**Average packet interval** is the arithmetic mean between distinct packet QRs actually painted on the sender, or distinct valid packets arriving at the receiver. Repeated scans/retries are not new interval samples. The value remains `—` until two packets have been observed; offer/acceptance time is excluded. It is a measured value, not the configured minimum hold or a promised transfer rate.

## Wire protocol

Each QR carries a JSON envelope with `v: 1`, a random transfer `id`, and a `type`:

| Frame | Content | Behavior |
| --- | --- | --- |
| `offer` | name, MIME, size, count, SHA-256 | Repeated until the receiver explicitly accepts or declines. |
| `ack` | `next` (zero-based next expected index) | `next: 0` accepts the offer; subsequent ACKs advance the sender one packet. |
| `data` | zero-based index, Base64 data, CRC-32 | Repeated until acknowledged. Duplicates are safe; damaged packets are ignored. |
| `done` | SHA-256 | Sent only after reassembly and whole-file verification; completes the sender. |
| `reject` / `cancel` | transfer id | Ends the matching transfer. Repeated while the terminal screen remains open. |

ACKs are cumulative. Only the currently expected ACK can advance the sender. The receiver retains packet indexes, shows which packets have not arrived, and waits for all packets before verifying the exact advertised length and SHA-256. Completion codes repeat so a lost final scan can recover. Offers, indexes, payload lengths, transfer IDs, and file sizes are validated before allocation or storage.

All displayed packet numbers are one-based. The sender's confirmed count means acknowledged by the receiver; the receiver's confirmed count means received with valid CRC. For large files, the visual grid groups packets into up to 256 cells; hover to see the range. The numeric count is exact and the missing list shows the first 12 pending indexes plus the total.

## Limits

- One transfer at a time, up to 5 MiB. The whole file is held in browser memory.
- No encryption or peer authentication. CRC/SHA detect corruption, not impersonation. Use only for data you are comfortable exposing visually.
- Keep both tabs active, devices awake, and QR codes in view. There is no cross-reload resume, background worker, or automatic timeout; a stalled transfer keeps retrying until cancelled.
- Camera frames are processed locally and never uploaded. File names are rendered as text and received contents are downloaded as binary rather than opened in the app.
- Cancellation is best effort: leave its QR visible long enough for the peer to scan it. If the peer is offline, cancel on both laptops.

## Validation

```sh
npm test
npm run build
```

Node tests cover binary and empty files, explicit acceptance, lost frames at every handshake stage, retries, duplicate frames, CRC corruption, invalid metadata/ACKs, cancellation/rejection, file-hash failures, a full packet round trip through the real QR encoder and decoder, and automatic timing/averaging/backoff with an injected clock. These simulate the optical channel and do not establish real-world camera throughput or reliability; a physical two-laptop test is still required.

Implementation: `src/protocol.js` owns the transport state machine, `src/app.js` owns cameras and UI, and `src/style.css` owns the responsive theme.

Libraries: [node-qrcode](https://github.com/soldair/node-qrcode), [jsQR](https://github.com/cozmo/jsQR).
