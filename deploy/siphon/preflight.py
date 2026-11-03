"""Validate required SIP deployment values without printing credentials or dialing."""
import ipaddress
import os
from pathlib import Path
import re
import sys

REQUIRED = (
    "ALIYUN_SIP_EXTENSION", "ALIYUN_SIP_DOMAIN", "ALIYUN_SIP_REGISTRAR_URI",
    "ALIYUN_SIP_AUTH_USER", "ALIYUN_SIP_PASSWORD", "ALIYUN_SIP_SOURCE_CIDRS",
    "SIPHON_ADVERTISED_HOST", "SIPHON_TLS_CERT_FILE", "SIPHON_TLS_KEY_FILE",
    "SIPHON_CONTROL_TOKEN", "SIPHON_RTP_CONTROL_SECRET", "SIPHON_ROUTE_FILE",
)
errors = [f"{name} is required" for name in REQUIRED if not os.environ.get(name, "").strip()]
if errors:
    sys.exit("SIP preflight refused:\n- " + "\n- ".join(errors))
if not re.fullmatch(r"[0-9]{4,20}", os.environ["ALIYUN_SIP_EXTENSION"]):
    errors.append("ALIYUN_SIP_EXTENSION must be a numeric dedicated seat")
uri = os.environ["ALIYUN_SIP_REGISTRAR_URI"]
if not re.fullmatch(r"sips?:[A-Za-z0-9.-]+:[0-9]+", uri):
    errors.append("ALIYUN_SIP_REGISTRAR_URI must name the confirmed TLS registrar and explicit port, without URI parameters")
if re.match(r"sips?:[0-9.]+:", uri):
    errors.append("TLS registrar must use the provider certificate's DNS hostname")
for cidr in os.environ["ALIYUN_SIP_SOURCE_CIDRS"].split(","):
    try:
        network = ipaddress.ip_network(cidr.strip(), strict=True)
        if network.prefixlen == 0:
            errors.append("Catch-all SIP source CIDR is forbidden")
    except ValueError:
        errors.append("ALIYUN_SIP_SOURCE_CIDRS contains an invalid CIDR")
for name in ("SIPHON_TLS_CERT_FILE", "SIPHON_TLS_KEY_FILE", "SIPHON_ROUTE_FILE"):
    if not Path(os.environ[name]).is_file():
        errors.append(f"{name} must name an existing file")
for name in ("SIPHON_CONTROL_TOKEN", "SIPHON_RTP_CONTROL_SECRET"):
    if len(os.environ[name]) < 32:
        errors.append(f"{name} must contain at least 32 characters")
try:
    ipaddress.ip_address(os.environ.get("SIPHON_SIP_BIND_IP", "127.0.0.1"))
    port = int(os.environ.get("SIPHON_SIP_PORT", "5061"))
    if not 1 <= port <= 65535:
        raise ValueError()
except ValueError:
    errors.append("SIP listener IP/port is invalid")
if errors:
    sys.exit("SIP preflight refused:\n- " + "\n- ".join(errors))
print("SIP preflight passed; registrar/source allowlist/certificates present. No registration or call initiated.")
