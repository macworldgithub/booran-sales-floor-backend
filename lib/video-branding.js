const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, readFile, rm, open } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { ObjectId } = require('mongodb');
const { fail } = require('./workflow-route');
const HYUNDAI_CONTACT_URL = 'https://www.southmoranghyundai.com.au/contact';
const validBrandingText = value => typeof value === 'string' && value.trim() && value.length <= 120;

function videoBranding(site) {
  let brands = {};
  try { brands = JSON.parse(process.env.VIDEO_BRANDING_JSON || '{}'); } catch { /* Invalid config stays unavailable. */ }
  const custom = brands && Object.hasOwn(brands, site) ? brands[site] : null;
  const hyundai = String(site).toLowerCase() === 'south morang hyundai';
  const config = custom || (hyundai ? {
    name: 'South Morang Hyundai', phone: process.env.HYUNDAI_VIDEO_PHONE || '03 8432 3000', email: process.env.HYUNDAI_VIDEO_EMAIL,
  } : null);
  if (!config || ![config.name, config.phone].every(validBrandingText)) return null;
  const details = { name: config.name.trim(), phone: config.phone.trim() };
  if (validBrandingText(config.email)) return { ...details, email: config.email.trim() };
  return hyundai && !custom ? { ...details, contactUrl: HYUNDAI_CONTACT_URL } : null;
}
async function command(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.stdout.on('data', bytes => { if (output.length < 100000) output += bytes; });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(Object.assign(new Error('Video branding requires FFmpeg and FFprobe on the backend server.'), { status: 503 })); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(Object.assign(new Error('Video branding failed. Check the video format and backend FFmpeg configuration, then retry.'), { status: 503 })); });
  });
}
function videoDimensions(probe) {
  const stream = probe.streams?.find(item => item.codec_type === 'video');
  let width = Number(stream?.width), height = Number(stream?.height);
  if (!width || !height) fail(400, 'This file does not contain a readable video.');
  const rotation = Number(stream.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
  if (Math.abs(rotation % 180) === 90) [width, height] = [height, width];
  const ratio = Math.min(1, 1280 / Math.max(width, height));
  return { width: Math.max(2, Math.round(width * ratio / 2) * 2), height: Math.max(2, Math.round(height * ratio / 2) * 2) };
}
function videoFilter(duration, directory, { width = 1280, height = 720 } = {}, branding = {}) {
  const escapePath = value => value.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
  const font = process.env.VIDEO_BRANDING_FONT;
  const fontOption = font ? `fontfile='${escapePath(font)}':` : '';
  const text = (file, size, y) => `drawtext=${fontOption}textfile='${escapePath(path.join(directory, file))}':expansion=none:fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=${y}:enable='gte(t,${duration})'`;
  const fit = (value, size) => Math.min(size, Math.max(12, Math.floor((width - 48) / Math.max(1, String(value || '').length) / 0.6)));
  return [`scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x002c5f`, 'setsar=1', 'fps=30',
    'tpad=stop_mode=add:stop_duration=4:color=0x002c5f', text('name.txt', fit(branding.name, 48), Math.round(height * 0.36)),
    text('phone.txt', fit(branding.phone, 32), Math.round(height * 0.50)), text('contact.txt', fit(branding.contact, 28), Math.round(height * 0.59)),
    `fade=t=out:st=${duration + 3.25}:d=0.75`].join(',');
}
const processing = new Map();
async function brandVideo(media, storage, branding) {
  if (!branding || !media.content_type.startsWith('video/')) return {};
  const key = String(media._id);
  if (processing.has(key)) return processing.get(key);
  const operation = (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'booran-video-'));
    try {
      let input = path.join(directory, 'input');
      if (media.storage_backend === 'mongodb') {
        const file = await open(input, 'w', 0o600);
        try { for (let offset = 0; offset < media.size; offset += storage.CHUNK_SIZE) await file.write(await storage.readRange(media, offset, Math.min(media.size - 1, offset + storage.CHUNK_SIZE - 1))); }
        finally { await file.close(); }
      } else await writeFile(input, await readFile(await storage.download(media)), { mode: 0o600 });
      const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
      const format = media.content_type === 'video/webm' ? 'matroska' : 'mov';
      const inputOptions = ['-protocol_whitelist', 'file', '-f', format];
      const inspect = async () => JSON.parse(await command(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', ...inputOptions, '-show_format', '-show_streams', '-of', 'json', input]));
      let probe = await inspect();
      if (!Number.isFinite(Number(probe.format?.duration)) && probe.format?.format_name?.includes('webm')) {
        // MediaRecorder WebM files often omit the duration from their container header.
        const indexed = path.join(directory, 'indexed.webm');
        await command(ffmpeg, ['-nostdin', '-v', 'error', ...inputOptions, '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-t', '181', indexed]);
        input = indexed;
        probe = await inspect();
      }
      const duration = Number(probe.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 180) fail(400, 'Record a video of three minutes or less.');
      const endCard = { name: branding.name, phone: branding.phone, contact: branding.contactUrl || branding.email };
      await Promise.all(Object.entries(endCard).map(([field, value]) => writeFile(path.join(directory, `${field}.txt`), value, { mode: 0o600 })));
      const output = path.join(directory, 'branded.mp4');
      const audio = probe.streams?.some(stream => stream.codec_type === 'audio');
      await command(ffmpeg, ['-nostdin', '-y', '-v', 'error', ...inputOptions, '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', videoFilter(duration, directory, videoDimensions(probe), endCard),
        ...(audio ? ['-af', `apad,afade=t=out:st=${duration + 3.25}:d=0.75`, '-c:a', 'aac'] : ['-an']),
        '-t', String(duration + 4), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]);
      const bytes = await readFile(output);
      if (bytes.length > storage.MAX_MEDIA_SIZE) fail(400, 'The branded video exceeds 100 MB. Record a shorter video.');
      const id = new ObjectId();
      const derivative = { ...media, _id: id, storage_media_id: undefined, size: bytes.length, content_type: 'video/mp4', staging_key: `staging/${id}`, storage_key: `files/${id}` };
      const upload = await storage.prepare(derivative);
      for (let offset = 0; offset < bytes.length; offset += upload.chunk_size) await storage.uploadChunk(derivative, offset, bytes.subarray(offset, offset + upload.chunk_size));
      await storage.complete(derivative);
      return { size: bytes.length, content_type: 'video/mp4', name: media.name.replace(/\.[^.]+$/, '') + '.mp4',
        storage_backend: derivative.storage_backend, storage_media_id: String(id), storage_chunk_size: derivative.storage_chunk_size, staging_key: derivative.staging_key, storage_key: derivative.storage_key,
        branding, branded_at: new Date().toISOString(), duration_ms: Math.round((duration + 4) * 1000) };
    } finally { await rm(directory, { recursive: true, force: true }); }
  })();
  processing.set(key, operation);
  try { return await operation; } finally { processing.delete(key); }
}
module.exports = { videoBranding, brandVideo, videoFilter, videoDimensions };
