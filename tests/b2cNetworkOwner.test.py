"""Real Linux tests; B2C_HELPER must name the previously approved pinned binary.

Run explicitly: B2C_HELPER=/tmp/.../slirp4netns python3 tests/b2cNetworkOwner.test.py
Not registered in the production app or ordinary npm test discovery.
"""
import importlib.util
import http.server
import json
import os
import pathlib
import re
import signal
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('network_owner', ROOT / 'src/main/experimental/network_owner.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
HELPER = os.environ.get('B2C_HELPER')
EVIDENCE = {}


def eventually(check, seconds=4):
    deadline = time.monotonic() + seconds
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError('condition did not become true')
        time.sleep(.03)


@unittest.skipUnless(HELPER, 'explicit approved B2C_HELPER required')
class OwnerTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='continuum-b2c-test-')
        self.w = self.scratch.name
        self.revoked = False
        self.owners = []

    def tearDown(self):
        for o in self.owners:
            o.close()
            self.assertEqual(o.cleanup_errors, [])
            self.assertTrue(all(p.poll() is not None for p in o._processes))
            self.assertEqual(o._fds, [])
        self.scratch.cleanup()

    def validate(self):
        if self.revoked:
            raise PermissionError('fixture revoked')

    def owner(self, lifetime=30):
        o = M.NetworkOwner(session='session-a', workspace=self.w, helper=HELPER,
                           validate=self.validate, lifetime=lifetime)
        self.owners.append(o)
        return o.start()

    def run_cmd(self, o, *argv):
        return o.run('session-a', self.w, list(argv))

    def curl(self, o, url, follow=False):
        return self.run_cmd(o, 'curl', '--noproxy', '*', '-sS', '--max-time', '2',
                            '--max-filesize', '4096', '-o', '/dev/null', '-w', '%{http_code}',
                            *(['-L'] if follow else []), url)

    def counter(self, o, name='denied4'):
        return int(re.search(r'packets (\d+)', o._trusted(['nft', 'list', 'counter',
                                                        'inet', 'continuum_b2c', name])).group(1))

    def test_01_before_after_public_dns_and_representations(self):
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'controlled-b2c-sentinel')

            def log_message(self, *_):
                pass

        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
            route.connect(('1.1.1.1', 443))
            address = route.getsockname()[0]
        server = http.server.HTTPServer((address, 0), H)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'http://{address}:{server.server_port}'
        try:
            control = subprocess.run(['curl', '--noproxy', '*', '-sS', '--max-time', '2', url], capture_output=True)
            self.assertEqual(control.stdout, b'controlled-b2c-sentinel')
            o = self.owner()
            # Fixture-only B2-A baseline: no exposed production toggle. Permit
            # only this controlled request while the trusted test removes rules.
            o._trusted(['nft', 'delete', 'table', 'inet', 'continuum_b2c'])
            before = self.curl(o, url)
            self.assertEqual(before[:2], (0, '200'))
            o._trusted(['nft', '-f', '-'], o._rules)
            n = self.counter(o)
            after = self.curl(o, url)
            self.assertNotEqual(after[0], 0)
            self.assertGreater(self.counter(o), n)
            EVIDENCE['private_host'] = {'positive_control': 200, 'before': 200,
                                        'after': 'nft rejection with counter increment'}
            https = self.curl(o, 'https://example.com')
            self.assertEqual(https[:2], (0, '200'))
            dns = self.run_cmd(o, 'python3', '-I', '-c',
                               'import socket; print(bool(socket.getaddrinfo("example.com",443)))')
            self.assertEqual(dns[:2], (0, 'True\n'))
            EVIDENCE['public_https'] = 200
            EVIDENCE['dns'] = True
            forms = [f'[::ffff:{address}]', str(int(M.ipaddress.IPv4Address(address))),
                     hex(int(M.ipaddress.IPv4Address(address)))]
            for representation in forms:
                with self.subTest(representation=representation):
                    n = self.counter(o)
                    self.assertNotEqual(self.curl(o, f'http://{representation}:{server.server_port}')[0], 0)
                    self.assertGreater(self.counter(o), n)
            EVIDENCE['mapped_integer_hex_forms'] = 'rejected by nft actual-destination counters'
            # The blocked packet verdict, not a connection timeout or absent
            # remote service, is the positive enforcement control for ranges.
            for target in ['10.1.2.3', '172.20.1.2', '192.168.1.2', '169.254.169.254',
                           '100.64.0.1', '192.0.2.1', '198.18.0.1', '10.0.2.2', '10.0.2.3']:
                n = self.counter(o)
                self.assertNotEqual(self.curl(o, f'http://{target}:12345')[0], 0)
                self.assertGreater(self.counter(o), n, target)
            EVIDENCE['special_ipv4_and_gateway'] = 'rejected before egress; counters increment'
            loopback=http.server.HTTPServer(('127.0.0.1',0),H)
            loop_thread=threading.Thread(target=loopback.serve_forever,daemon=True);loop_thread.start()
            try:
                check=subprocess.run(['curl','--noproxy','*','-sS','--max-time','2',f'http://127.0.0.1:{loopback.server_port}'],capture_output=True)
                self.assertEqual(check.stdout,b'controlled-b2c-sentinel')
                self.assertNotEqual(self.curl(o,f'http://127.0.0.1:{loopback.server_port}')[0],0)
                n=self.counter(o)
                self.assertNotEqual(self.curl(o,f'http://10.0.2.2:{loopback.server_port}')[0],0)
                self.assertGreater(self.counter(o),n)
                EVIDENCE['host_loopback'] = 'positive host control; separate guest loopback; alias nft rejection'
            finally:
                loopback.shutdown();loopback.server_close();loop_thread.join()
            for target in ['fd42::1', 'fe80::1%25tap0', 'fd00::2', 'fd00::3', '2001:db8::1']:
                n = self.counter(o, 'denied6')
                self.assertNotEqual(self.curl(o, f'http://[{target}]:12345')[0], 0)
                self.assertGreater(self.counter(o, 'denied6'), n, target)
            EVIDENCE['external_ipv6'] = 'all denied, including ULA/link-local/gateway; counters increment'
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_02_guest_local_redirect_and_dns_changes(self):
        o = self.owner()
        status = pathlib.Path(f'/proc/{o.helper.pid}/status').read_text()
        self.assertIn('NoNewPrivs:\t1', status)
        self.assertIn('Seccomp:\t2', status)
        self.assertEqual(int(re.search(r'CapEff:\s*([0-9a-f]+)',status).group(1),16), 1<<10)
        self.assertNotEqual(os.stat(f'/proc/{o.helper.pid}/root').st_ino, os.stat('/').st_ino)
        EVIDENCE['helper_hardening'] = 'mount sandbox, no_new_privs, seccomp mode 2; no NET_ADMIN'
        # The guest fixture is both a local HTTP server and a local DNS server.
        # Its second DNS response changes from public to private (rebinding).
        code = r'''import http.server,socket,struct,threading
class H(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(302 if self.path=='/redirect' else 200)
  if self.path=='/redirect':self.send_header('Location','http://10.1.2.3:12345/')
  self.end_headers()
 def log_message(self,*args):pass
def dns():
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('127.0.0.1',45353))
 for address in ['1.1.1.1','10.1.2.3']:
  q,peer=s.recvfrom(512)
  s.sendto(q[:2]+b'\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00'+q[12:]+b'\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x00\x00\x04'+socket.inet_aton(address),peer)
 s.close()
threading.Thread(target=dns,daemon=True).start()
class V6(http.server.HTTPServer):address_family=socket.AF_INET6
v6=V6(('::1',43120),H)
threading.Thread(target=v6.serve_forever,daemon=True).start()
http.server.HTTPServer(('127.0.0.1',43119),H).serve_forever()
'''
        p = o.launch('session-a', self.w, ['python3', '-I', '-c', code])
        eventually(lambda: self.curl(o, 'http://127.0.0.1:43119')[0] == 0)
        self.assertEqual(self.curl(o,'http://[::1]:43120')[:2],(0,'200'))
        n = self.counter(o)
        self.assertNotEqual(self.curl(o, 'http://127.0.0.1:43119/redirect', True)[0], 0)
        self.assertGreater(self.counter(o), n)
        client = r'''import socket,struct
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(2)
q=b'\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x06rebind\x04test\x00\x00\x01\x00\x01'
answers=[]
for i in range(2):
 s.sendto(q,('127.0.0.1',45353));data=s.recv(512);answers.append(socket.inet_ntoa(data[-4:]))
assert answers==['1.1.1.1','10.1.2.3'],answers
try:socket.create_connection((answers[-1],12345),timeout=2)
except OSError:print('changed DNS answer denied')
else:raise AssertionError('private destination reached')
'''
        n = self.counter(o)
        self.assertEqual(self.run_cmd(o, 'python3', '-I', '-c', client)[:2], (0, 'changed DNS answer denied\n'))
        self.assertGreater(self.counter(o), n)
        self.assertIsNone(p.poll())
        EVIDENCE['guest_local_http'] = 200
        EVIDENCE['redirect_and_dns_change'] = 'private second destination rejected; counters increment'

    def test_03_hostile_commands_authority_and_w7(self):
        o = self.owner()
        for command in [ ['/usr/sbin/nft','flush','ruleset'],
                         ['/usr/sbin/ip','route','add','1.2.3.4/32','dev','lo'],
                         ['/usr/sbin/ip','link','set','tap0','down'],
                         ['unshare','--user','--map-root-user','/usr/sbin/nft','flush','ruleset'] ]:
            status, _, err = self.run_cmd(o, *command)
            self.assertNotEqual(status, 0)
            self.assertIn('permitted', err)
        probe = '''import os,fcntl
for n in os.listdir('/proc/self/fd'):
 try: target=os.readlink('/proc/self/fd/'+n)
 except FileNotFoundError: continue
 assert not target.startswith(('net:[','user:[')),target
try:fcntl.ioctl(os.open('/proc/self/ns/net',os.O_RDONLY),0xb701)
except PermissionError: print('authority unavailable')
else:raise AssertionError('parent userns authority leaked')
'''
        self.assertEqual(self.run_cmd(o, 'python3', '-I', '-c', probe)[:2], (0, 'authority unavailable\n'))
        with self.assertRaises(M.NetworkError):
            o.run('session-b', self.w, ['true'])
        with tempfile.TemporaryDirectory(prefix='b2c-other-') as other:
            with self.assertRaises(M.NetworkError):
                o.run('session-a', other, ['true'])
            peer=M.NetworkOwner(session='session-b',workspace=other,helper=HELPER,validate=self.validate).start()
            self.owners.append(peer)
            denied=self.run_cmd(o,'nsenter',f'--net=/proc/{peer.owner.pid}/ns/net','true')
            self.assertNotEqual(denied[0],0)
            EVIDENCE['cross_namespace_entry'] = 'peer host namespace handle inaccessible inside fresh PID/proc sandbox'
        with socket.socket(socket.AF_UNIX) as poisoned:
            poisoned.bind(self.w + '/exposed.sock')
            with self.assertRaisesRegex(M.NetworkError,'NETWORK_FILESYSTEM_PREPARATION_FAILED'):
                o.launch('session-a', self.w, ['true'])
        os.unlink(self.w + '/exposed.sock')
        hidden = pathlib.Path(self.w, '.llm_workspace/sandbox/tmp')
        hidden.mkdir(parents=True)
        with socket.socket(socket.AF_UNIX) as internal:
            internal.bind(str(hidden/'hidden.sock'))
            self.assertEqual(self.run_cmd(o, 'true')[0], 0)
        EVIDENCE['hostile_filter_route_interface_child_userns'] = 'EPERM'
        EVIDENCE['namespace_fds_and_owning_userns'] = 'unavailable to guest'
        EVIDENCE['cross_session_workspace'] = 'denied before launch'
        EVIDENCE['w7'] = 'exposed socket rejected; masked internal socket preserved'
        for family, kind, proto in [('AF_PACKET','SOCK_RAW',3),('AF_INET','SOCK_RAW',1)]:
            code=f'import socket;socket.socket(socket.{family},socket.{kind},{proto})'
            result=self.run_cmd(o,'python3','-I','-c',code)
            self.assertNotEqual(result[0],0)
            self.assertIn('Operation not permitted',result[2])
        EVIDENCE['raw_packet_bypass'] = 'EPERM for AF_PACKET and raw IP'

    def test_04_lifecycle(self):
        for _ in range(3):
            o = self.owner()
            self.assertEqual(self.run_cmd(o, 'true')[0], 0)
            o.close('session_cancelled')
        o = self.owner(lifetime=1)
        eventually(lambda:o.closed)
        self.assertEqual(o.reason,'expired')
        o = self.owner()
        os.kill(o.helper.pid, signal.SIGKILL)
        eventually(lambda:o.closed)
        self.assertEqual(o.reason,'network_process_exited')
        with self.assertRaises(M.NetworkError):self.run_cmd(o,'true')
        o = self.owner()
        o._drop_fd(o.exit_fd)
        eventually(lambda:o.closed)
        o = self.owner()
        o.owner.stdin.close()
        eventually(lambda:o.closed)
        o = self.owner()
        self.revoked=True
        eventually(lambda:o.closed)
        self.assertEqual(o.reason,'authorization_or_monitor_failed')
        self.revoked=False
        o = self.owner()
        with self.assertRaisesRegex(M.NetworkError,'ALREADY_STARTED'):o.start()
        self.assertRaises(M.NetworkError,self.run_cmd,o,'python3','-c','print("x"*100000)')
        o.close('application_shutdown')
        # Failed startup must release the owner slot and not retain helpers.
        o = M.NetworkOwner(session='session-a',workspace=self.w,helper='/usr/bin/true',validate=self.validate)
        self.owners.append(o)
        with self.assertRaises(M.NetworkError):o.start()
        self.assertTrue(o.closed)
        EVIDENCE['lifecycle'] = ['repeated_start_stop','expiry','helper_crash','lost_exit_fd',
                                 'owner_control_EOF','revocation','session_cancel','shutdown','output_limit','failed_start']

    def test_05_parent_death_and_failed_policy_setup(self):
        # Parent subprocess publishes only handles it owns. Kill only this
        # fixture parent, then verify its children are dead (zombies count as
        # exited, not running); no unrelated process is signalled.
        code='''import importlib.util,json,sys,time
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('owner',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
o=m.NetworkOwner(session='parent-fixture',workspace=sys.argv[2],helper=sys.argv[3],validate=lambda:None,lifetime=15).start()
print(json.dumps({'pids':[o.owner.pid,o.helper.pid],'directory':str(o.directory)}),flush=True)
time.sleep(15)
'''
        parent=subprocess.Popen(['/usr/bin/python3','-I','-c',code,str(ROOT/'src/main/experimental/network_owner.py'),self.w,HELPER],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        resources=None
        try:
            resources=json.loads(M.read_ready(parent.stdout.fileno()))
            pids=resources['pids']
            parent.kill()
            parent.wait(timeout=3)
            def dead(pid):
                try:return pathlib.Path(f'/proc/{pid}/stat').read_text().split(') ')[1][0]=='Z'
                except FileNotFoundError:return True
            eventually(lambda:all(dead(pid) for pid in pids))
            EVIDENCE['parent_termination'] = 'owner control EOF and helper exit-FD HUP stop both children'
        finally:
            if parent.poll() is None:parent.kill();parent.wait()
            parent.stdout.close();parent.stderr.close()
            if resources:
                # This is the exact directory created by our killed fixture.
                shutil.rmtree(resources['directory'])
        o=M.NetworkOwner(session='session-a',workspace=self.w,helper=HELPER,validate=self.validate)
        self.owners.append(o)
        original=o._trusted
        def broken(argv,text=None):
            if argv[:2]==['/usr/sbin/nft','-f']:
                raise M.NetworkError('NETWORK_POLICY_SETUP_FAILED','injected setup failure')
            return original(argv,text)
        o._trusted=broken
        with self.assertRaisesRegex(M.NetworkError,'NETWORK_POLICY_SETUP_FAILED'):o.start()
        self.assertTrue(o.closed)
        self.assertFalse(hasattr(o,'helper'))
        EVIDENCE['policy_startup_failure'] = 'no transport started; namespace torn down'
        o=M.NetworkOwner(session='session-a',workspace=self.w,helper=HELPER,validate=self.validate)
        self.owners.append(o)
        spawn=o._spawn
        def crash_helper(argv,**kwargs):
            p=spawn(argv,**kwargs)
            if '--enable-sandbox' in argv:o._kill(p)
            return p
        o._spawn=crash_helper
        with self.assertRaisesRegex(M.NetworkError,'NETWORK_HELPER_SETUP_FAILED'):o.start()
        self.assertTrue(o.closed)
        EVIDENCE['helper_startup_failure'] = 'injected crash; no ready owner or host fallback'


if __name__ == '__main__':
    result=unittest.main(exit=False,verbosity=2).result
    print('B2C_EVIDENCE '+json.dumps(EVIDENCE,sort_keys=True))
    raise SystemExit(not result.wasSuccessful())
