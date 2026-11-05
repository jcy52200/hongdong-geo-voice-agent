"""Print provider-specific UFW rules; only --apply mutates the firewall.

Use Alibaba-confirmed CIDRs. This never changes cloud security groups, existing
rules or SSH access, and never permits the private application/control ports.
"""
import argparse
import ipaddress
import shlex
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--signaling', required=True, help='comma separated provider signaling CIDRs')
parser.add_argument('--media', required=True, help='comma separated provider RTP CIDRs')
parser.add_argument('--sip-port', type=int, default=5060)
parser.add_argument('--transport', choices=['udp', 'tcp'], default='udp')
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
if not 1 <= args.sip_port <= 65535:
    parser.error('invalid SIP port')


def networks(value):
    result = []
    for item in value.split(','):
        net = ipaddress.ip_network(item.strip(), strict=True)
        if net.prefixlen == 0:
            parser.error('catch-all networks are not allowed')
        result.append(str(net))
    if not result:
        parser.error('provider CIDRs must not be empty')
    return result


rules = []
for net in networks(args.signaling):
    rules.append(['ufw', 'allow', 'proto', args.transport, 'from', net, 'to', 'any', 'port', str(args.sip_port), 'comment', 'hongdong SIP provider'])
for net in networks(args.media):
    rules.append(['ufw', 'allow', 'proto', 'udp', 'from', net, 'to', 'any', 'port', '30000:30199', 'comment', 'hongdong RTP provider'])
for rule in rules:
    print(shlex.join(rule))
    if args.apply:
        subprocess.run(rule, check=True)
print('Cloud security groups require the same confirmed provider-scoped rules separately.')
