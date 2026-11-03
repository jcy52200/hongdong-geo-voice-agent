/** Isolated synthetic ingress fixture only: TLS 127.0.0.1:15061, control 19092.
 * Uses the official SDK, never .env, cloud SIP, a real customer, or model audio.
 * Start a separate SIPhon fixture with the matching synthetic seat/token first.
 */
import tls from 'node:tls';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlClient } from '@siphon-project/control';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<400;i++){let value=fn();if(value)return value;await sleep(5);}throw new Error(label);}
let client;for(let i=0;i<50&&!client;i++){try{client=await ControlClient.connect({url:'ws://127.0.0.1:19092/control/ws',app:'hongdong-pilot',token:'synthetic-token-01234567890123456789'});}catch{await sleep(100);}}if(!client)throw new Error('Fixture SIP control unavailable');
const events=[];client.onEvent(e=>{if(e.type==='event')events.push(e.frame);});
const incoming=[];
async function invite(seat){
 const id=randomUUID();const branch=`z9hG4bK-${id}`;let body='';
 const peer=tls.connect({host:'127.0.0.1',port:15061,servername:'pilot.example.invalid',rejectUnauthorized:false});
 await new Promise((ok,bad)=>{peer.once('secureConnect',ok);peer.once('error',bad);});
 peer.on('data',bytes=>{body+=bytes.toString();});
 const headers=`Via: SIP/2.0/TLS 127.0.0.1:15555;branch=${branch};rport\r\nMax-Forwards: 70\r\nFrom: <sip:fixture@sip.example.invalid>;tag=fixture-${id}\r\nTo: <sip:${seat}@pilot.example.invalid>\r\nCall-ID: ${id}\r\n`;
 const sdp='v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=fixture\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 40000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n';
 peer.write(`INVITE sip:${seat}@pilot.example.invalid SIP/2.0\r\n${headers}CSeq: 1 INVITE\r\nContact: <sip:fixture@127.0.0.1:15555;transport=tls>\r\nContent-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdp)}\r\n\r\n${sdp}`);
 incoming.push(peer);
 return {id,read:()=>body,ack:()=>peer.write(`ACK sip:${seat}@pilot.example.invalid SIP/2.0\r\n${headers}CSeq: 1 ACK\r\nContent-Length: 0\r\n\r\n`)};
}
try{
 const call=await invite('12345678');
 const event=await until(()=>events.find(e=>e.event==='StasisStart'&&e.sip_call_id===call.id),'No actual StasisStart');
 assert.equal(event.payload.invite.ruri,'sip:12345678@pilot.example.invalid');
 assert.equal(event.payload.vars.pilot_seat,'12345678');assert.equal(event.payload.vars.pilot_source,'aliyun_ccc');
 assert.equal(event.payload.source_ip,'127.0.0.1');
 assert.ok(!call.read().includes('SIP/2.0 200'),'route must not answer before controller');
 await client.command('sip','reject',{channel:event.channel},{code:603,reason:'Synthetic fixture complete'});
 await until(()=>call.read().includes('SIP/2.0 603'),'No controlled reject');call.ack();
 const wrong=await invite('87654321');await until(()=>wrong.read().includes('SIP/2.0 403'),'Wrong target not forbidden');wrong.ack();
 assert.ok(!events.some(e=>e.event==='StasisStart'&&e.sip_call_id===wrong.id));
 console.log(JSON.stringify({ok:true,officialSdk:'0.11.0',actualTlsInvite:true,actualStasisStart:true,correctRuriAndVars:true,noAutoAnswer:true,wrongSeatForbidden:true}));
}finally{await sleep(50);for(const p of incoming)p.destroy();client.shutdown();}
