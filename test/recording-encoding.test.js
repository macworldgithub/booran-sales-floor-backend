const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { brandVideo } = require('../lib/video-branding');

// Opt-in real encoder coverage; fixtures must be synthetic MediaRecorder output.
// Generate with scripts/generate-recording-fixtures.js, then set
// RECORDING_FIXTURE_DIR to run this file on a machine with FFmpeg and FFprobe.
const fixtureDirectory = process.env.RECORDING_FIXTURE_DIR;
const probe = async file => JSON.parse((await execFile(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file])).stdout);

// Reproduce a wrapped duration on the last video sample without changing PTS.
function wrappedDuration(bytes) {
  const output = Buffer.from(bytes), durations = [];
  function boxes(start, end, video = false) {
    for (let at = start; at + 8 <= end;) {
      const size = output.readUInt32BE(at), type = output.toString('ascii', at + 4, at + 8);
      if (size < 8 || at + size > end) break;
      if (type === 'moof') boxes(at + 8, at + size);
      if (type === 'traf') {
        let track = false;
        for (let child = at + 8; child + 8 <= at + size;) {
          const childSize = output.readUInt32BE(child);
          if (childSize < 8) break;
          if (output.toString('ascii', child + 4, child + 8) === 'tfhd') track = output.readUInt32BE(child + 12) === 1;
          child += childSize;
        }
        boxes(at + 8, at + size, track);
      }
      if (type === 'trun' && video) {
        const flags = output.readUInt32BE(at + 8) & 0xffffff, count = output.readUInt32BE(at + 12);
        let field = at + 16 + ((flags & 1) ? 4 : 0) + ((flags & 4) ? 4 : 0);
        for (let sample = 0; sample < count; sample++) {
          if (flags & 0x100) { durations.push(field); field += 4; }
          for (const flag of [0x200, 0x400, 0x800]) if (flags & flag) field += 4;
        }
        assert.ok(field <= at + size);
      }
      at += size;
    }
  }
  boxes(0, output.length);
  assert.ok(durations.length, 'Fixture must contain explicit video sample durations');
  output.writeUInt32BE(0xffffffff, durations.at(-1));
  return output;
}

for (const name of ['landscape.webm', 'portrait.webm', 'landscape.mp4', 'portrait.mp4', 'wrapped.mp4']) {
  test(`synthetic ${name} encodes with audio, correct orientation and dealership end card`, { skip: !fixtureDirectory, timeout: 180000 }, async t => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'booran-recording-test-'));
    t.after(async () => {
      assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
      await fs.rm(directory, { recursive: true, force: true });
    });
    const input = path.join(directory, 'input'), source = await fs.readFile(path.join(fixtureDirectory, name === 'wrapped.mp4' ? 'landscape.mp4' : name));
    await fs.writeFile(input, name === 'wrapped.mp4' ? wrappedDuration(source) : source);
    const before = await probe(input);
    if (name === 'wrapped.mp4') assert.ok(Number(before.format.duration) > 180, 'Fixture reproduces corrupt duration');
    const outputs = new Map();
    const storage = {
      MAX_MEDIA_SIZE: 500 * 1024 * 1024,
      download: async media => media._id === 'synthetic' ? input : path.join(directory, String(media._id)),
      prepare: async media => { media.storage_backend = 'local'; outputs.set(String(media._id), []); return { chunk_size: 2 * 1024 * 1024 }; },
      uploadChunk: async (media, offset, chunk) => { const chunks = outputs.get(String(media._id)); assert.equal(Buffer.concat(chunks).length, offset); chunks.push(chunk); },
      complete: async media => fs.writeFile(path.join(directory, String(media._id)), Buffer.concat(outputs.get(String(media._id)))),
    };
    const result = await brandVideo({ _id: 'synthetic', name, content_type: name.endsWith('webm') ? 'video/webm' : 'video/mp4', size: source.length }, storage, { name: 'Fixture dealership', phone: '0000000000', email: 'fixture@example.test' });
    const output = path.join(directory, result.storage_media_id), after = await probe(output);
    assert.ok(Number(after.format.duration) >= 5 && Number(after.format.duration) < 9);
    assert.ok(after.streams.some(stream => stream.codec_type === 'audio'));
    const video = after.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video.width < video.height, name.startsWith('portrait'));
    // Decode the whole result, then sample an end-card corner before the fade.
    await execFile(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-']);
    const duration = result.duration_ms / 1000 - 4;
    const { stdout: pixel } = await execFile(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-ss', String(duration + 1), '-i', output, '-vf', 'crop=2:2:0:0,scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
    assert.ok(pixel.length === 3 && Math.abs(pixel[0]) < 8 && Math.abs(pixel[1] - 44) < 8 && Math.abs(pixel[2] - 95) < 8, `Expected navy end card, got ${[...pixel]}`);
  });
}
