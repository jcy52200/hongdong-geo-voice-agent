// ECS-only synthetic SBC. All SIP goes to 127.0.0.1; no PSTN call or CCC API.
// Uses the existing Seed key for one synthetic greeting. Run with node --import tsx.
import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server/app.ts';
import { TelephoneMediaServer } from '../../server/telephony/media-server.ts';
import { SiphonControl } from '../../server/telephony/siphon-control.ts';
import { TrunkPilot } from '../../server/telephony/trunk-pilot.ts';
import { readTrunkConfig } from '../../server/telephony/trunk-config.ts';
import { Recordings } from '../../server/recordings.ts';

const sbc = dgram.createSocket('udp4'), rtp = dgram.createSocket('udp4');
const root = `/var/lib/hongdong-geo/selftest-${randomUUID()}`;
await mkdir(root, { mode: 0o700 });
await new Promise(resolve => sbc.bind(26060, '127.0.0.1', resolve));
await new Promise(resolve => rtp.bind(0, '0.0.0.0', resolve));
let packets = 0, bytes = 0, generator, sequence = 0, initialInvite, signalingPeer;
rtp.on('message', packet => { if (packet.length > 12) { packets++; bytes += packet.length - 12; } });
const header = (text, name) => text.split('\r\n').find(line => line.toLowerCase().startsWith(name.toLowerCase() + ':'))?.split(':').slice(1).join(':').trim() || '';
const respond = (text, code, reason, peer, body = '') => {
  const to = header(text, 'To');
  const response = [`SIP/2.0 ${code} ${reason}`, `Via: ${header(text, 'Via')}`, `From: ${header(text, 'From')}`,
    `To: ${to}${to.includes(';tag=') ? '' : ';tag=local-fixture'}`, `Call-ID: ${header(text, 'Call-ID')}`, `CSeq: ${header(text, 'CSeq')}`,
    'Contact: <sip:fixture@127.0.0.1:26060>', ...(body ? ['Content-Type: application/sdp'] : []),
    `Content-Length: ${Buffer.byteLength(body)}`, '', body].join('\r\n');
  sbc.send(response, peer.port, peer.address);
};
sbc.on('message', (packet, peer) => {
  const text = packet.toString();
  if (text.startsWith('INVITE ')) {
    initialInvite = text; signalingPeer = peer;
    respond(text, 180, 'Ringing', peer);
    const sdp = ['v=0', `o=fixture 1 1 IN IP4 ${process.env.ECS_PRIVATE_IP}`, 's=local-only', `c=IN IP4 ${process.env.ECS_PRIVATE_IP}`, 't=0 0',
      `m=audio ${rtp.address().port} RTP/AVP 8`, 'a=rtpmap:8 PCMA/8000', 'a=ptime:20', 'a=sendrecv', ''].join('\r\n');
    respond(text, 200, 'OK', peer, sdp);
  } else if (text.startsWith('ACK ')) {
    const port = Number(text.match(/^m=audio (\d+)/m)?.[1]);
    if (port && !generator) generator = setInterval(() => {
      const packet = Buffer.alloc(172, 0xd5); packet[0] = 0x80; packet[1] = 8;
      packet.writeUInt16BE(sequence % 65536, 2); packet.writeUInt32BE(sequence * 160 >>> 0, 4); packet.writeUInt32BE(12345678, 8); sequence++;
      // Local fixture deliberately bypasses public-EIP hairpin routing.
      rtp.send(packet, port, process.env.ECS_PRIVATE_IP);
    }, 20);
  } else if (text.startsWith('BYE ') || text.startsWith('OPTIONS ')) respond(text, 200, 'OK', peer);
});
const app = createApp({ databasePath: ':memory:', apiKey: process.env.SEED_API_KEY, webSearchKey: process.env.SEED_WEBSEARCH_API_KEY, recordingsPath: root });
const db = new DatabaseSync(process.env.GEO_DATABASE_PATH, { readOnly: true });
const row = db.prepare("SELECT value FROM settings WHERE key='agent'").get(); db.close();
if (row) app.store.saveConfig(JSON.parse(row.value));
const customer = app.store.importCustomers([{ camp: '本机门窗联调测试公司', name: '合成测试', phone: '13800000000', address: '石家庄', industry: '门窗' }])[0];
const config = readTrunkConfig({ ...process.env, ALIYUN_TRUNK_HOST: '127.0.0.1', ALIYUN_TRUNK_PORT: '26060', ALIYUN_TRUNK_AUTH: 'ip',
  ALIYUN_TRUNK_CALLER: '01012345678', ALIYUN_TRUNK_TO_TEMPLATE: 'sip:{phone}@{host}:{port};transport=udp', ALIYUN_TRUNK_FROM_TEMPLATE: 'sip:{caller}@{public_ip}',
  ALIYUN_SIP_SOURCE_CIDRS: '127.0.0.1/32', ALIYUN_RTP_SOURCE_CIDRS: '127.0.0.1/32', ALIYUN_TRUNK_LATE_OFFER_CONFIRMED: 'true',
  ALIYUN_TRUNK_ANSWER_IS_CUSTOMER_CONFIRMED: 'true', PILOT_TEST_PHONE: '13800000000',
  PILOT_GATEWAY_RECORDINGS_PATH: process.env.PILOT_GATEWAY_RECORDINGS_PATH, SIPHON_RECORDINGS_PATH: process.env.SIPHON_RECORDINGS_PATH });
if (!config.config) throw new Error('Invalid local fixture configuration');
const control = await SiphonControl.connect({ url: config.config.controlUrl, token: config.config.controlToken });
const media = new TelephoneMediaServer(); await media.listen(3001);
const pilot = new TrunkPilot(app.store, app.manager, control, media, new Recordings(`${root}/archive`), config.config);
let timer;
try {
  const call = await pilot.start(customer.id);
  app.manager.observe(call.id, event => {
    if (event.type === 'state' && event.status === 'active') {
      if (process.argv.includes('--peer-hangup')) {
        const request = [`BYE ${header(initialInvite, 'Contact').replace(/[<>]/g, '')} SIP/2.0`,
          `Via: SIP/2.0/UDP 127.0.0.1:26060;branch=z9hG4bK${randomUUID()}`, `From: ${header(initialInvite, 'To')};tag=local-fixture`,
          `To: ${header(initialInvite, 'From')}`, `Call-ID: ${header(initialInvite, 'Call-ID')}`, 'CSeq: 2 BYE', 'Max-Forwards: 70', 'Content-Length: 0', '', ''].join('\r\n');
        sbc.send(request, signalingPeer.port, signalingPeer.address);
      } else void pilot.stop('local_selftest_complete').catch(() => {});
    }
  });
  timer = setTimeout(() => { void pilot.stop('local_selftest_timeout', true).catch(() => {}); }, 30000);
  const final = await pilot.finished;
  const report = { localOnly: true, pstnCallPlaced: false, status: final.status, answerSource: final.answerSource,
    packets, bytes, playbackFacts: final.playbacks?.length ?? 0, recording: final.telephone?.recordingStatus, cleanup: final.telephone?.cleanupStatus };
  console.log(JSON.stringify(report));
  if (final.status !== 'completed' || !packets || final.telephone?.recordingStatus !== 'ready') process.exitCode = 1;
} finally {
  clearTimeout(timer); clearInterval(generator);
  await pilot.close().catch(() => {}); await media.close(); await control.close(); await app.close(); sbc.close(); rtp.close();
}
