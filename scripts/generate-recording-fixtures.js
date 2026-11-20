const { chromium } = require('playwright-core');
const { writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
// Usage: RECORDING_BROWSER_PATH=/path/to/chrome node scripts/generate-recording-fixtures.js /tmp/fixtures
(async () => {
  if (!process.argv[2]) throw Error('Supply a directory for synthetic recording fixtures.');
  const directory = path.resolve(process.argv[2]);
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.RECORDING_BROWSER_PATH || chromium.executablePath(), headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body>Isolated synthetic recording fixture</body></html>');
    for (const format of ['video/webm;codecs=vp8,opus', 'video/mp4']) {
      for (const portrait of [false, true]) {
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
        result = await page.evaluate(async ({ format, portrait }) => {
          if (!MediaRecorder.isTypeSupported(format)) return null;
          const canvas = document.createElement('canvas'); canvas.width = portrait ? 360 : 640; canvas.height = portrait ? 640 : 360;
          const context = canvas.getContext('2d'), audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
          oscillator.connect(destination); oscillator.start(); await audio.resume();
          let frame = 0;
          const draw = () => { context.fillStyle = '#93452a'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = 'white'; context.fillRect(frame++ % 100, 10, 50, 50); };
          const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...destination.stream.getAudioTracks()]);
          draw(); const timer = setInterval(() => { draw(); stream.getVideoTracks()[0].requestFrame?.(); }, 33);
          const recorder = new MediaRecorder(stream, { mimeType: format }), chunks = [];
          recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
          const done = new Promise(resolve => { recorder.onstop = resolve; });
          recorder.start(500); await new Promise(resolve => setTimeout(resolve, 3100)); recorder.stop(); await done;
          clearInterval(timer); stream.getTracks().forEach(track => track.stop()); oscillator.stop(); await audio.close();
          const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
          let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
          return { base64: btoa(binary), mime: recorder.mimeType, chunks: chunks.length };
        }, { format, portrait });
        if (result?.base64) break;
        }
        if (!result) throw Error(`Unavailable fixture format: ${format}`);
        const name = `${portrait ? 'portrait' : 'landscape'}.${format.includes('mp4') ? 'mp4' : 'webm'}`;
        const bytes = Buffer.from(result.base64, 'base64'); if (!bytes.length) throw Error(`Empty fixture: ${name}`); await writeFile(path.join(directory, name), bytes);
        console.log(JSON.stringify({ name, bytes: bytes.length, mime: result.mime, chunks: result.chunks }));
      }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
