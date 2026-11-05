"""Outbound-only trunk: existing dialogs stay on Siphon's SIP core.

Only explicit control originate can create an outbound call. No relay,
automatic answer, inbound AI, or public transit service is provided.
"""
import os
import ipaddress
import json
from pathlib import Path
from siphon import proxy, b2bua, rtpengine

networks = [part.strip() for part in os.environ.get('ALIYUN_SIP_SOURCE_CIDRS', '127.0.0.1/32').split(',') if part.strip()]
for value in networks:
    if ipaddress.ip_network(value, strict=True).prefixlen == 0:
        raise RuntimeError('Catch-all SIP sources are not permitted')


@proxy.on_request('OPTIONS')
def options(request):
    request.reply(200 if request.source_ip_in(networks) else 403, 'OK' if request.source_ip_in(networks) else 'Forbidden')


@b2bua.on_invite
async def invite(call):
    call.reject(486 if call.source_ip_in(networks) else 403, 'Outbound test only')


@rtpengine.on_recording_finished
def recording_finished(call_id, from_tag, recording_id, path, reason, duration_ms):
    # A call can leave the control registry before its writer closes. This
    # native engine callback survives that removal. Publish the actual closed
    # event atomically, never infer completion from a WAV appearing on disk.
    if not path:
        return
    root = Path(os.environ['PILOT_GATEWAY_RECORDINGS_PATH']).resolve()
    recording = Path(path)
    if recording.is_symlink() or recording.parent.resolve() != root or recording.suffix != '.wav':
        return
    target = Path(str(recording) + '.closed.json')
    temporary = Path(str(target) + '.tmp')
    payload = dict(schema=1, source='rtpengine.on_recording_finished', call_id=call_id,
                   recording_id=recording_id, path=str(recording), reason=reason, duration_ms=duration_ms)
    with temporary.open('w', encoding='utf8') as handle:
        os.chmod(temporary, 0o600)
        json.dump(payload, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
