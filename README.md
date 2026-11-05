# Lumen · QR Transfer Protocol (QRTP/2)

A plain HTML, CSS, and JavaScript application that transfers files between two laptops using their screens and cameras. File bytes travel in QR codes; no WebRTC, sockets, remote storage, or file-upload server is involved. Vite serves and bundles the app, `qrcode` generates codes, and `jsqr` decodes camera frames. Both QR libraries are bundled locally.

## Hosted app

Open [Lumen on GitHub Pages](https://maanas-verma.github.io/qr-protocol/) on both laptops and allow camera access. No local installation is required to use the hosted version.

Pushes to `main` run the protocol tests, build with the `/qr-protocol/` asset base, and deploy `dist/` using `.github/workflows/deploy-pages.yml`. The workflow can also be run manually from GitHub Actions.

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

Start with a tiny text file. Both laptops must load the current app: QRTP/2 is incompatible with the earlier stop-and-wait version, so refresh both pages before transferring. Files are still sent one at a time; packets of that file are streamed without waiting for individual acknowledgments.

### Streaming and automatic timing

The sender cycles through a sliding window of **32 unconfirmed packets**, each containing 384 bytes. Every 600 ms, the receiver displays a compact batch acknowledgment: a cumulative base and a 32-bit bitmap of received packets beyond that base. Successfully confirmed packets immediately leave the sender's loop. Missed packets stay in the loop; received out-of-order packets are retained. The window advances as gaps are filled, so the sender does not need to loop over the whole file.

The initial display interval is 180 ms. Capture feedback from batches tunes it between 100 and 1000 ms: after at least eight reported transmission attempts, an 85% or better confirmation ratio speeds it up by 10%, while a ratio below 55% slows it down by 25%. If no fresh batch report arrives for three seconds, it also slows by 25%. The actual rate depends on the camera, focus, lighting, QR size, decoder speed, and dropped scans. No speed selector is exposed.

A queued data QR must be painted before the protocol can issue another, so a busy browser cannot silently skip data frames. Decoding runs in a **Web Worker**, with one camera frame in flight at a time, keeping the main thread available for QR painting and the UI. Static offer, completion, cancellation, and error codes remain visible; their retry notifications back off from 1800 ms up to 10 seconds.

**Average packet interval** is the arithmetic mean between first displays of distinct packets on the sender, or first valid arrivals of distinct packets on the receiver. Retransmissions do not create new samples, but time spent on retries remains part of the observed gaps. The value remains `—` until two distinct packets have been observed. Retries count actual repeated data packets.

## Wire protocol

Each QR carries a JSON envelope with `v: 2`, a random transfer `id`, and a `type`:

| Frame | Content | Behavior |
| --- | --- | --- |
| `offer` | name, MIME, size, count, SHA-256 | Repeated until the receiver explicitly accepts or declines. |
| `ack` | `base`, eight-character hex `seen`, report `seq`, last captured frame `through` | Acceptance starts with base 0 and an empty bitmap. Subsequent reports acknowledge batches; bit offsets are relative to base and least-significant-bit first within each byte. |
| `data` | packet index, frame `seq`, Base64 bytes, CRC-32 | Streamed on a timer. Unconfirmed indexes cycle within the current window; confirmed indexes are skipped. |
| `finish` | transfer id | Sender has all packet acknowledgments and asks for the final checksum result. |
| `done` | SHA-256 | Sent after successful reassembly and verification; finishes the sender. |
| `error` | transfer id | File verification failed; neither side reports success. |
| `reject` / `cancel` | transfer id | Ends the matching transfer. Repeated while the terminal screen remains open. |

The receiver accepts valid packets out of order within the fixed window. ACKs cumulatively confirm every index below `base`, and selectively confirm indexes represented in `seen`. Reports cannot acknowledge indexes the sender has not issued. Old report sequences are ignored, confirmed indexes never regress, and completion requires all packets plus the advertised SHA-256. A lost final confirmation recovers through the persistent completion code or repeated `finish` requests.

All displayed packet numbers are one-based. The sender's confirmed count is the exact number of distinct acknowledged indexes, including packets beyond a gap. The receiver's count is the number received with valid CRC. The grid shows every issued-but-unconfirmed group as in flight. For large files it groups packets into up to 256 cells; hover to see the range. The missing list shows the first 12 pending indexes and the exact total.

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

Node tests cover binary/empty files, consent, window bounds, streaming before feedback, sparse/out-of-order receipt, removal of confirmed packets from the loop, loss of data and batch/final reports, stale reports, CRC and SHA-256 errors, invalid input, cancellation, renderer backpressure, adaptive capture timing, actual QR encode/decode, and simultaneous offers.

For a browser integration check, run `npm run dev`, open `/tests/optical-loopback.html`, and click **Run optical loopback**. It renders real QR images, decodes them in the production worker, deliberately drops two packet scans and a batch report, then checks the reconstructed bytes. This generated-image test does not use a physical camera.

A deterministic simulated channel with 400 ms latency each way transfers 80 packets in about 12.85 simulated seconds, versus a 64-second round-trip-only lower bound for stop-and-wait. This is a protocol simulation, **not a physical camera benchmark**. Real two-laptop throughput still needs measurement.

Implementation: `src/protocol.js` owns the transport state machine, `src/app.js` owns cameras and UI, `src/scanner.worker.js` decodes frames off the main thread, and `src/style.css` owns the responsive theme.

Libraries: [node-qrcode](https://github.com/soldair/node-qrcode), [jsQR](https://github.com/cozmo/jsQR).
