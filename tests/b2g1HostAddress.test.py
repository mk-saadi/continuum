"""Opt-in real-kernel counterexample, never a production activation mechanism.

B2G1_HELPER=/tmp/continuum-b2-a-backend/slirp4netns python3 tests/b2g1HostAddress.test.py
The outer unshare has no uplink. All public-numbered addresses are disposable.
A scheduling barrier delays the real monitor; netlink and sockets are real.
"""
import importlib.util
import json
import os
import pathlib
import re
import selectors
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
P = '11.22.33.44'
PORT = 43129
EVIDENCE = {}


def run(*argv, text=None):
    return subprocess.run(argv, input=text, text=True, capture_output=True,
                          timeout=6, check=True).stdout


def inside():
    # Refuse mutations unless our wrapper proved a different network namespace.
    assert os.environ['B2G1_ORIGINAL_NETNS'] != os.readlink('/proc/self/ns/net')
    assert json.loads(run('/usr/sbin/ip', '-j', 'link'))[0]['ifname'] == 'lo'
    assert len(json.loads(run('/usr/sbin/ip', '-j', 'link'))) == 1
    spec = importlib.util.spec_from_file_location('owner', ROOT / 'src/main/experimental/network_owner.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class HeldMonitor(module.NetworkOwner):
        def _monitor_loop(self):
            # Model a legal scheduling delay, not a mocked address lookup or
            # synthetic notification. Always bounded by owner test teardown.
            if self.monitor_release.wait(20):
                super()._monitor_loop()

    class HostAddressTests(unittest.TestCase):
        def setUp(self):
            run('/usr/sbin/ip', 'link', 'set', 'lo', 'up')
            self.temp = tempfile.TemporaryDirectory(prefix='b2g1-')
            self.owners = []
            # A sibling remote namespace provides a real routed positive
            # control. It never receives a route to the real host/internet.
            self.remote = subprocess.Popen(['/usr/bin/unshare', '--net', '/usr/bin/python3', '-I', '-c',
                'import os,sys;print(os.getpid(),flush=True);sys.stdin.buffer.read(1)'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.remote_pid = int(module.read_ready(self.remote.stdout.fileno()))
            run('/usr/sbin/ip', 'link', 'add', 'uplink', 'type', 'veth', 'peer', 'name', 'peer')
            run('/usr/sbin/ip', 'link', 'set', 'peer', 'netns', str(self.remote_pid))
            run('/usr/sbin/ip', 'addr', 'add', '192.0.2.1/30', 'dev', 'uplink')
            run('/usr/sbin/ip', 'link', 'set', 'uplink', 'up')
            self.remote_run('/usr/sbin/ip', 'link', 'set', 'lo', 'up')
            self.remote_run('/usr/sbin/ip', 'addr', 'add', '192.0.2.2/30', 'dev', 'peer')
            self.remote_run('/usr/sbin/ip', 'link', 'set', 'peer', 'up')
            self.remote_run('/usr/sbin/ip', 'addr', 'add', P + '/32', 'dev', 'lo')
            run('/usr/sbin/ip', 'route', 'add', P + '/32', 'via', '192.0.2.2')
            code = '''import socket,sys,threading
marker=sys.argv[1].encode()
def tcp():
 s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('0.0.0.0',43129));s.listen(8)
 print('ready',flush=True)
 while True:
  c,_=s.accept();c.settimeout(2)
  try:
   while c.recv(64):c.sendall(marker)
  except OSError:pass
  finally:c.close()
threading.Thread(target=tcp,daemon=True).start()
u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);u.setsockopt(socket.SOL_IP,15,1);u.bind(('11.22.33.44',43129))
while True:
 d,a=u.recvfrom(64);u.sendto(marker,a)
'''
            self.servers = []
            for prefix, marker in [([], 'HOST'), (self.remote_prefix(), 'REMOTE')]:
                p = subprocess.Popen(prefix + ['/usr/bin/python3', '-I', '-c', code, marker],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.servers.append(p)
                self.assertEqual(module.read_ready(p.stdout.fileno()), b'ready\n')

        def remote_prefix(self):
            return ['/usr/bin/nsenter', f'--net=/proc/{self.remote_pid}/ns/net']

        def remote_run(self, *args):
            return run(*self.remote_prefix(), *args)

        def owner(self):
            o = HeldMonitor(session='g1', workspace=self.temp.name,
                            helper=os.environ['B2G1_HELPER'], validate=lambda: None, lifetime=20)
            o.monitor_release = threading.Event()
            self.owners.append(o)
            return o.start()

        def assign(self):
            run('/usr/sbin/ip', 'addr', 'add', P + '/32', 'dev', 'lo')

        def remove(self):
            run('/usr/sbin/ip', 'addr', 'del', P + '/32', 'dev', 'lo')

        def request(self, o):
            return o.run('g1', self.temp.name, ['python3', '-I', '-c',
                f'import socket;s=socket.create_connection(("{P}",{PORT}),timeout=1);s.sendall(b"x");print(s.recv(64).decode())'])

        def counter(self, o):
            return int(re.search(r'packets (\d+)', o._trusted(
                ['nft', 'list', 'counter', 'inet', 'continuum_b2c', 'denied4'])).group(1))

        def tearDown(self):
            for o in self.owners:
                o.close('fixture_cleanup')
                o.monitor_release.set()
                o._monitor.join(timeout=2)
                self.assertFalse(o._monitor.is_alive())
                self.assertEqual(o.cleanup_errors, [])
            for p in self.servers + [self.remote]:
                p.terminate()
                p.wait(timeout=3)
                for stream in (p.stdin, p.stdout, p.stderr):
                    if stream: stream.close()
            run('/usr/sbin/ip', 'link', 'del', 'uplink')
            # Removing an absent address is expected after most fixtures.
            subprocess.run(['/usr/sbin/ip', 'addr', 'del', P + '/32', 'dev', 'lo'], capture_output=True)
            self.temp.cleanup()

        def test_01_initially_owned_is_rejected_with_counter(self):
            self.assign()
            o = self.owner()
            n = self.counter(o)
            self.assertNotEqual(self.request(o)[0], 0)
            self.assertGreater(self.counter(o), n)
            EVIDENCE['initially_owned'] = 'denied4 counter increased'

        def test_02_new_assignment_exposes_host_before_real_monitor(self):
            o = self.owner()
            self.assertEqual(self.request(o)[:2], (0, 'REMOTE\n'))
            n = self.counter(o)
            self.assign()
            self.assertEqual(self.request(o)[:2], (0, 'HOST\n'))
            self.assertEqual(self.counter(o), n)
            with selectors.DefaultSelector() as selector:
                selector.register(o._watch, selectors.EVENT_READ)
                self.assertTrue(selector.select(1), 'real netlink notification must be queued')
            o.monitor_release.set()
            o._monitor.join(timeout=3)
            self.assertTrue(o.closed)
            self.assertEqual(o.reason, 'host_network_changed')
            EVIDENCE['new_assignment'] = {'before': 'REMOTE', 'after': 'HOST',
                'snapshot_counter_delta': 0, 'real_netlink_queued': True,
                'released_monitor': 'host_network_changed'}

        def test_03_churn_and_route_replacement(self):
            o = self.owner()
            for _ in range(8):
                self.assertEqual(self.request(o)[:2], (0, 'REMOTE\n'))
                self.assign()
                self.assertEqual(self.request(o)[:2], (0, 'HOST\n'))
                self.remove()
            # Route-only local ownership bypasses an interface-address snapshot.
            run('/usr/sbin/ip', 'route', 'add', 'local', P + '/32', 'dev', 'lo')
            try:
                self.assertEqual(self.request(o)[:2], (0, 'HOST\n'))
            finally:
                run('/usr/sbin/ip', 'route', 'del', 'local', P + '/32', 'dev', 'lo')
            EVIDENCE['churn'] = {'cycles': 8, 'host_marker_each_assignment': True,
                                  'local_route_without_address': 'HOST'}

        def test_04_assignment_between_check_and_connect(self):
            o = self.owner()
            # A real route lookup says unicast/remote; assignment occurs before
            # the subsequent real connect. This disproves lookup-then-connect.
            route = json.loads(run('/usr/sbin/ip', '-j', 'route', 'get', P))[0]
            self.assertEqual(route['dev'], 'uplink')
            self.assign()
            self.assertEqual(self.request(o)[:2], (0, 'HOST\n'))
            EVIDENCE['preconnect_lookup'] = 'uplink lookup -> assignment -> HOST'

        def test_05_existing_udp_socket_reroutes_to_host(self):
            o = self.owner()
            # Keep the SAME slirp UDP mapping/socket alive across assignment.
            client = o.launch('g1', self.temp.name, ['python3', '-I', '-c', f'''import socket,time
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(2);s.connect(('{P}',{PORT}))
s.send(b'x');print(s.recv(64).decode(),flush=True)
time.sleep(.8)
s.send(b'x');print(s.recv(64).decode(),flush=True)
'''])
            self.assertEqual(module.read_ready(client.stdout.fileno()), b'REMOTE\n')
            self.assign()
            self.assertEqual(module.read_ready(client.stdout.fileno()), b'HOST\n')
            self.assertEqual(client.wait(timeout=3), 0)
            EVIDENCE['existing_udp'] = 'same guest socket REMOTE -> HOST'

        def test_06_local_delivery_boundary_positive_control(self):
            o = self.owner()
            self.assertEqual(self.request(o)[:2], (0, 'REMOTE\n'))
            # ONLY in this disposable surrogate host. This tests the hook, not
            # deployment of the proposed privileged veth broker on a real host.
            run('/usr/sbin/nft', '-f', '-', text=f'''table inet g1 {{
 counter denied {{ }}
 chain input {{ type filter hook input priority 0; policy accept;
 ip daddr {P} tcp dport {PORT} counter name denied reject
 }}
}}''')
            try:
                self.assign()
                self.assertNotEqual(self.request(o)[0], 0)
                count = int(re.search(r'packets (\d+)', run('/usr/sbin/nft', 'list', 'counter', 'inet', 'g1', 'denied')).group(1))
                self.assertGreater(count, 0)
                run('/usr/sbin/nft', 'delete', 'table', 'inet', 'g1')
                with socket.create_connection((P, PORT), timeout=2) as control:
                    control.sendall(b'x')
                    self.assertEqual(control.recv(64), b'HOST')
                EVIDENCE['local_delivery_hook'] = {'denied_counter': count,
                    'host_service_positive_control_after_guard_removal': 'HOST', 'production_architecture_qualified': False}
            finally:
                subprocess.run(['/usr/sbin/nft', 'delete', 'table', 'inet', 'g1'], capture_output=True)

        def test_07_established_tcp_across_assignment(self):
            o = self.owner()
            client = o.launch('g1', self.temp.name, ['python3', '-I', '-c', f'''import socket,time
s=socket.create_connection(('{P}',{PORT}),timeout=1)
s.sendall(b'x');print(s.recv(64).decode(),flush=True)
time.sleep(.8)
try:
 s.sendall(b'x');print(s.recv(64).decode() or 'EOF',flush=True)
except OSError as e:print(type(e).__name__,flush=True)
'''])
            self.assertEqual(module.read_ready(client.stdout.fileno()), b'REMOTE\n')
            self.assign()
            observed = module.read_ready(client.stdout.fileno()).decode().strip()
            self.assertIn(observed, ['REMOTE', 'HOST', 'EOF', 'TimeoutError', 'ConnectionResetError', 'BrokenPipeError'])
            self.assertEqual(client.wait(timeout=3), 0)
            EVIDENCE['existing_tcp_observed'] = observed

        def test_08_real_monitor_descriptor_failure_closes_owner(self):
            o = self.owner()
            self.assertEqual(self.request(o)[:2], (0, 'REMOTE\n'))
            o._watch.close()
            o.monitor_release.set()
            o._monitor.join(timeout=3)
            self.assertTrue(o.closed)
            self.assertEqual(o.reason, 'authorization_or_monitor_failed')
            with self.assertRaises(module.NetworkError):
                self.request(o)
            EVIDENCE['monitor_failure'] = 'closed; later launch denied'

    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(HostAddressTests))
    print('B2G1_EVIDENCE ' + json.dumps(EVIDENCE, sort_keys=True), flush=True)
    return int(not result.wasSuccessful())


if __name__ == '__main__':
    if '--inside' in sys.argv:
        raise SystemExit(inside())
    if not os.environ.get('B2G1_HELPER'):
        print('B2G1_HELPER is required; no tests executed', file=sys.stderr)
        raise SystemExit(2)
    env = dict(os.environ, B2G1_ORIGINAL_NETNS=os.readlink('/proc/self/ns/net'), PYTHONDONTWRITEBYTECODE='1')
    result = subprocess.run(['/usr/bin/unshare', '--user', '--map-root-user', '--net',
        '--pid', '--fork', '--kill-child=KILL', '--mount-proc', '/usr/bin/python3', '-I', str(pathlib.Path(__file__).resolve()), '--inside'], env=env, timeout=120)
    raise SystemExit(result.returncode)
