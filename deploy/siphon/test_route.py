"""Run: python3 -m unittest discover -s deploy/siphon -p 'test_*.py'. No real SIP."""
import asyncio
import ipaddress
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROUTE = Path(__file__).with_name("route.py")


def load_route(environment):
    fake = types.ModuleType("siphon")
    fake.b2bua = types.SimpleNamespace(on_invite=lambda fn: fn)
    fake.proxy = types.SimpleNamespace(on_request=lambda method: lambda fn: fn)
    scope = {"__name__": "tested_route", "__file__": str(ROUTE)}
    with patch.dict(sys.modules, {"siphon": fake}), patch.dict("os.environ", environment, clear=True):
        exec(compile(ROUTE.read_text(), str(ROUTE), "exec"), scope)
    return scope


class Call:
    def __init__(self, source="192.0.2.5", target="12345678", to="12345678"):
        self.source = source
        self.ruri = types.SimpleNamespace(user=target)
        self.to_uri = types.SimpleNamespace(user=to)
        self.handover_calls = []
        self.rejections = []

    def source_ip_in(self, networks):
        return any(ipaddress.ip_address(self.source) in ipaddress.ip_network(n) for n in networks)

    def reject(self, *args):
        self.rejections.append(args)

    def handover(self, *args, **kwargs):
        self.handover_calls.append((args, kwargs))


class RoutingPolicyTests(unittest.TestCase):
    def setUp(self):
        self.env = {"ALIYUN_SIP_EXTENSION": "12345678", "ALIYUN_SIP_SOURCE_CIDRS": "192.0.2.0/24"}

    def test_dedicated_seat_handover_does_not_answer_or_dial(self):
        route = load_route(self.env)["route"]
        call = Call()
        asyncio.run(route(call))
        self.assertEqual(call.rejections, [])
        self.assertEqual(call.handover_calls, [(("hongdong-pilot",), {
            "on_lost": "hangup", "deadline_ms": 5000,
            "vars": {"pilot_seat": "12345678", "pilot_source": "aliyun_ccc"},
        })])

    def test_wrong_source_or_either_wrong_seat_is_rejected(self):
        route = load_route(self.env)["route"]
        for call in [Call(source="198.51.100.1"), Call(target="87654321"), Call(to="87654321")]:
            with self.subTest(source=call.source, target=call.ruri.user, to=call.to_uri.user):
                asyncio.run(route(call))
                self.assertEqual(call.rejections, [(403, "Forbidden")])
                self.assertEqual(call.handover_calls, [])

    def test_missing_policy_and_catchall_cidr_fail_closed(self):
        for env in [{}, {"ALIYUN_SIP_EXTENSION": "12345678"},
                    {**self.env, "ALIYUN_SIP_SOURCE_CIDRS": "0.0.0.0/0"},
                    {**self.env, "ALIYUN_SIP_SOURCE_CIDRS": "not-a-cidr"}]:
            with self.subTest(env=env), self.assertRaises((RuntimeError, ValueError)):
                load_route(env)


if __name__ == "__main__":
    unittest.main()
