/** Real engine ↔ UDP ↔ WebSocket loopback, synthetic audio only. No SIP or cloud calls. */
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const controlPort = Number(process.env.SIPHON_VERIFY_CONTROL_PORT || 8080);
const directory = process.env.SIPHON_VERIFY_RECORDING_DIR || '/recordings';
const callId = `loopback-${randomUUID()}`;
const fromTag = 'synthetic-caller';
let fatal;
async function until(predicate, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fatal) throw fatal;
    const result = predicate();
    if (result) return result;
    await sleep(5);
  }
  throw new Error(`Timeout: ${label}`);
}
const socket = net.createConnection({ host: '127.0.0.1', port: controlPort });
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
socket.on('error', error => { fatal = error; });
let buffered = Buffer.alloc(0);
let sequence = 0;
const pending = new Map();
const events = [];
socket.on('data', chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
    const length = buffered.readUInt32BE(0);
    if (length > 1024 * 1024) { fatal = new Error('Control frame exceeds 1MiB'); return; }
    const message = JSON.parse(buffered.subarray(4, length + 4).toString());
    buffered = buffered.subarray(length + 4);
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else events.push(message);
  }
});
async function request(command, properties = {}) {
  const id = ++sequence;
  const bytes = Buffer.from(JSON.stringify({ id, command, ...properties }));
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  const result = new Promise(resolve => pending.set(id, resolve));
  socket.write(Buffer.concat([header, bytes]));
  const message = await Promise.race([result, sleep(8000).then(() => { throw new Error(`No reply: ${command}`); })]);
  pending.delete(id);
  assert.notEqual(message.result, 'error', `${command}: ${message.reason}`);
  return message;
}
const rtp = dgram.createSocket('udp4');
await new Promise(resolve => rtp.bind(0, '127.0.0.1', resolve));
const packets = [];
rtp.on('message', (bytes) => packets.push({ bytes, at: performance.now() }));
const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => wsServer.once('listening', resolve));
let peer;
let announcement;
let uplinkFrames = 0;
const controls = [];
wsServer.on('connection', client => {
  peer = client;
  client.on('error', error => { fatal = error; });
  client.on('message', (bytes, binary) => {
    if (binary) { uplinkFrames++; return; }
    const message = JSON.parse(bytes.toString());
    if (message.type === 'start') announcement = message.data;
    controls.push({ ...message, receivedAt: performance.now() });
  });
});
let callerClock;
const send = (type, data) => peer.send(JSON.stringify({ type, data: { streamId: announcement.streamId, ...data } }));
try {
  if (process.env.SIPHON_RTP_CONTROL_SECRET) await request('authenticate', { token: process.env.SIPHON_RTP_CONTROL_SECRET });
  await request('ping');
  const port = rtp.address().port;
  const sdp = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=synthetic-loopback\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio ${port} RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=ptime:20\r\na=sendrecv\r\n`;
  const response = await request('answer_local', { call_id: callId, from_tag: fromTag, sdp,
    profile: { ws_uri: `ws://127.0.0.1:${wsServer.address().port}/synthetic`, ws_sample_rate: 16000, ws_barge_in: false } });
  await until(() => announcement, 'start');
  assert.equal(announcement.callId, callId);
  assert.equal(announcement.metadata?.playbackDrainProtocol, 'hongdong-playout-v1');
  assert.equal(announcement.metadata?.playbackDrainScope, 'successful_udp_egress_plus_ptime');
  assert.deepEqual(announcement.media, { encoding: 'L16', sampleRate: 16000, channels: 1, bitDepth: 16, endianness: 'little', ptime: 20 });
  const enginePort = Number(/m=audio\s+(\d+)/.exec(response.sdp)?.[1]);
  assert.ok(enginePort > 0, 'answer must contain engine RTP port');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${callId}.wav`);
  const recording = await request('start_recording', { call_id: callId, from_tag: fromTag, format: 'wav',
    direction: 'both', channels: 'stereo', path });
  let rtpSequence = 0;
  callerClock = setInterval(() => {
    const packet = Buffer.alloc(172, 0x90); // deterministic, nonzero μ-law caller audio
    packet[0] = 0x80; packet[1] = 0;
    packet.writeUInt16BE(rtpSequence & 65535, 2);
    packet.writeUInt32BE((rtpSequence * 160) >>> 0, 4);
    packet.writeUInt32BE(1234, 8); rtpSequence++;
    rtp.send(packet, enginePort, '127.0.0.1');
  }, 20);
  send('play_start', { playId: 'opening', source: 'binary', interruptible: false, markName: 'played' });
  // 500ms, paced at the declared ptime; never overfill the upstream 8-frame ring.
  const startedAt = performance.now();
  for (let frame = 0; frame < 25; frame++) {
    const pcm = Buffer.alloc(640);
    for (let sample = 0; sample < 320; sample++) {
      pcm.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * (frame * 320 + sample) / 16000)), sample * 2);
    }
    peer.send(pcm);
    await sleep(20);
  }
  send('play_stop', { playId: 'opening' });
  const played = await until(() => controls.find(m => m.type === 'mark' && m.data.playId === 'opening' && m.data.name === 'played'), 'successful playback mark');
  assert.ok(played.receivedAt - startedAt >= 500, 'opening must not complete before its audio duration');
  const playing = controls.filter(m => m.type === 'mark' && m.data.playId === 'opening' && m.data.name === 'playing');
  assert.equal(playing.length, 1, 'actual playback start must be acknowledged exactly once');
  assert.ok(playing[0].receivedAt >= startedAt && playing[0].receivedAt < played.receivedAt, 'playing and drained are separate facts');
  assert.ok(packets.some(({bytes, at}) => at <= playing[0].receivedAt && at >= startedAt && bytes.subarray(12).some(v => v < 220)), 'playing must follow an actual non-silent bot RTP packet');
  assert.ok(packets.length >= 25, 'actual RTP UDP packets must reach caller socket');
  assert.ok(packets.some(({ bytes }) => bytes.length === 172 && bytes.subarray(12).some(v => v < 220)), 'bot audio must reach actual G.711 payload');
  await until(() => uplinkFrames > 5, 'caller RTP decoded to WS L16');
  // A queued segment explicitly discarded by clear is never acknowledged as played.
  send('play_start', { playId: 'discarded', source: 'binary', interruptible: true, markName: 'played' });
  for (let frame = 0; frame < 5; frame++) peer.send(Buffer.alloc(640));
  send('play_stop', { playId: 'discarded' });
  send('clear', { reason: 'barge_in' });
  await until(() => controls.find(m => m.type === 'mark' && m.data.name === 'cleared'), 'clear acknowledgement');
  await sleep(150);
  assert.ok(!controls.some(m => m.type === 'mark' && m.data.playId === 'discarded' && m.data.name === 'played'));
  await request('stop_recording', { call_id: callId, from_tag: fromTag, recording_id: recording.recording_id });
  const finished = await until(() => events.find(m => m.event === 'recording_finished' && m.recording_id === recording.recording_id), 'recording closed');
  assert.equal(finished.path, path);
  const wav = await readFile(path);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let format; let audio;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const length = wav.readUInt32LE(offset + 4); const type = wav.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') format = wav.subarray(offset + 8, offset + 8 + length);
    if (type === 'data') audio = wav.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + (length % 2);
  }
  assert.equal(format?.readUInt16LE(2), 2, 'original recording must contain caller and heard tracks');
  assert.ok(audio?.length > 3200, 'recording must contain real audio');
  let left = false; let right = false;
  for (let offset = 0; offset + 4 <= audio.length; offset += 4) {
    left ||= audio.readInt16LE(offset) !== 0; right ||= audio.readInt16LE(offset + 2) !== 0;
  }
  assert.ok(left && right, 'both caller and actual bot egress tracks must contain audio');
  console.log(JSON.stringify({ ok: true, engine: '0.19.0 + hongdong-playout-v1',
    wireRate: announcement.media.sampleRate, receivedRtpPackets: packets.length, uplinkFrames,
    playingAfterMs: Math.round(playing[0].receivedAt - startedAt),
    playedAfterMs: Math.round(played.receivedAt - startedAt), clearIsNotDrain: true,
    recording: { path, bytes: wav.length, channels: 2, closed: true } }, null, 2));
} finally {
  clearInterval(callerClock);
  try { await request('delete', { call_id: callId, from_tag: fromTag }); } catch {}
  socket.destroy(); rtp.close();
  for (const client of wsServer.clients) client.terminate();
  await new Promise(resolve => wsServer.close(resolve));
}
