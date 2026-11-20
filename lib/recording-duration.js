const { fail } = require('./workflow-route');
const MAX_DURATION = 180;
const positive = value => value !== '' && value != null && Number.isFinite(Number(value)) && Number(value) > 0;

// Browser MP4s can contain a wrapped 32-bit sample duration while their
// presentation timestamps remain correct. Never trust a client duration.
function packetDuration(probe) {
  const samples = (probe.packets || []).map(packet => ({
    at: packet.pts_time !== '' && packet.pts_time != null ? Number(packet.pts_time) : packet.dts_time !== '' && packet.dts_time != null ? Number(packet.dts_time) : NaN,
    duration: positive(packet.duration_time) && Number(packet.duration_time) <= 1 ? Number(packet.duration_time) : null,
  })).filter(sample => Number.isFinite(sample.at) && sample.at >= 0);
  if (samples.length < 2) fail(400, 'The recording duration could not be verified. Please record the video again.');
  samples.sort((a, b) => a.at - b.at);
  const gaps = samples.slice(1).map((sample, index) => sample.at - samples[index].at).filter(gap => gap > 0 && gap <= 1).sort((a, b) => a - b);
  const frame = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const last = samples.at(-1), tail = last.duration || frame;
  if (!tail || !frame) fail(400, 'The recording duration could not be verified. Please record the video again.');
  const duration = last.at - samples[0].at + tail;
  if (!(duration > 0 && duration <= MAX_DURATION)) fail(400, 'Record a video of three minutes or less.');
  return duration;
}
async function recordingDuration(probe, readPackets) {
  const declared = Number(probe.format?.duration);
  if (declared > 0 && declared <= MAX_DURATION) return declared;
  return packetDuration(await readPackets());
}
module.exports = { recordingDuration, packetDuration, MAX_DURATION };
