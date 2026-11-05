import jsQR from 'jsqr';
self.onmessage = ({ data: { id, buffer, width, height } }) => {
  try {
    const code = jsQR(new Uint8ClampedArray(buffer), width, height, { inversionAttempts: 'dontInvert' });
    self.postMessage({ id, text: code?.data || null });
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
