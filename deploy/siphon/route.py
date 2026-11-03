"""Dedicated Alibaba CCC seat ingress; no dial, answer, or automatic model start.

SIPHON 1.15.11 embedded Python API. Node takes ownership, authenticates its
one-shot pilot window and answers with answerAnchored. Empty/invalid policy
is a startup error. Never turn this into a public SIP transit route.
"""
import ipaddress
import os
import re
from siphon import b2bua, proxy


def required(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required deployment variable: {name}")
    return value


SEAT = required("ALIYUN_SIP_EXTENSION")
if not re.fullmatch(r"[0-9]{4,20}", SEAT):
    raise RuntimeError("ALIYUN_SIP_EXTENSION must be the dedicated numeric seat")
SOURCE_CIDRS = [part.strip() for part in required("ALIYUN_SIP_SOURCE_CIDRS").split(",") if part.strip()]
for cidr in SOURCE_CIDRS:
    network = ipaddress.ip_network(cidr, strict=True)
    if network.prefixlen == 0:
        raise RuntimeError("A catch-all SIP source CIDR is forbidden")
APP = "hongdong-pilot"


def allowed_source(call):
    return call.source_ip_in(SOURCE_CIDRS)


@proxy.on_request("OPTIONS")
def options(request):
    if request.source_ip_in(SOURCE_CIDRS):
        request.reply(200, "OK")
    else:
        request.reply(403, "Forbidden")


@b2bua.on_invite
async def route(call):
    # Both request target and To identity must match. Never infer seat from From.
    target = call.ruri
    recipient = call.to_uri
    if (not allowed_source(call) or target is None or recipient is None
            or target.user != SEAT or recipient.user != SEAT):
        call.reject(403, "Forbidden")
        return
    call.handover(APP, on_lost="hangup", deadline_ms=5000,
                  vars={"pilot_seat": SEAT, "pilot_source": "aliyun_ccc"})
