"""B2-C internal Linux experiment. Not imported by any production entry point.

No tool/IPC/renderer entry point and no default-on switch. Python is a test
dependency here, not a new supported packaged runtime. All authority must be
provided by a trusted test caller, never workspace code or tool arguments.
"""
import datetime
import fcntl
import hashlib
import ipaddress
import json
import os
import pathlib
import stat
import resource
import selectors
import signal
import socket
import subprocess
import tempfile
import threading
import time

HELPER_SHA256 = 'dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980'
# Conservative superset of IANA IPv4 special registry (2025-10-09), plus
# multicast. Even globally reachable special-purpose assignments are denied.
SPECIAL4 = ('0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
            '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
            '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24',
            '192.168.0.0/16', '192.175.48.0/24', '198.18.0.0/15',
            '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}


class NetworkError(RuntimeError):
    def __init__(self, code, detail=''):
        self.code = code
        super().__init__(code + (': ' + detail[:400] if detail else ''))


def validate_address_policy(policy, today=None):
    """Validate trusted release data without permitting accidental broadening.

    The reviewed baseline is a floor, not a replacement for upstream review.
    Deadlines use UTC, independent of the desktop's local timezone.
    """
    try:
        today = today or datetime.datetime.now(datetime.timezone.utc).date()
        reviewed = datetime.date.fromisoformat(policy['reviewed'])
        due = datetime.date.fromisoformat(policy['reviewDue'])
        if (type(policy['version']) is not int or policy['version'] != 1 or
                policy['externalIpv6'] != 'deny' or today > due or
                not 0 < (due - reviewed).days <= 30):
            raise ValueError('invalid review window or schema')
        prefixes = policy['deniedIpv4']
        if not isinstance(prefixes, list) or not prefixes or len(prefixes) > 256:
            raise ValueError('invalid prefixes')
        networks = [ipaddress.IPv4Network(prefix, strict=True) for prefix in prefixes]
        if len(set(networks)) != len(networks):
            raise ValueError('duplicate prefixes')
        coverage = list(ipaddress.collapse_addresses(networks))
        if any(not any(ipaddress.IPv4Network(base).subnet_of(net) for net in coverage)
               for base in SPECIAL4):
            raise ValueError('reviewed baseline was broadened')
        return tuple(str(net) for net in networks)
    except (ValueError, TypeError, KeyError) as error:
        raise NetworkError('NETWORK_ADDRESS_POLICY_REVIEW_REQUIRED', str(error)) from error


def limits():
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)


def read_ready(fd):
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        if not selector.select(5):
            raise NetworkError('NETWORK_STARTUP_TIMEOUT')
        return os.read(fd, 4096)


def rules(host_addresses, network_policy="standard_outbound"):
    if network_policy not in ("public_only_fixture", "standard_outbound", "trusted_development"):
        raise NetworkError("NETWORK_POLICY_INVALID")
    if network_policy == "trusted_development":
        # Explicit trust: private/host IPv4 is permitted. No host-isolation claim.
        return '''table inet continuum_b2c {
 counter denied4 { }
 counter denied6 { }
 chain output {
  type filter hook output priority 0; policy drop;
  oifname "lo" accept
  meta nfproto ipv6 counter name denied6 reject
  meta nfproto ipv4 accept
 }
}\n'''
    # Standard outbound: ordinary public internet only. Host-side special-use
    # IPv4 (loopback, private, carrier NAT, link-local, …) is rejected so that
    # plain outbound access never silently grants private/host capabilities.
    addresses = sorted({str(ipaddress.IPv4Address(a)) for a in host_addresses})
    hosts = ', '.join(addresses) or '0.0.0.0'
    return f'''table inet continuum_b2c {{
 set restricted4 {{ type ipv4_addr; flags interval; elements = {{ {', '.join(SPECIAL4)} }} }}
 set host4 {{ type ipv4_addr; elements = {{ {hosts} }} }}
 counter denied4 {{ }}
 counter denied6 {{ }}
 chain output {{
  type filter hook output priority 0; policy drop;
  oifname "lo" accept
  ip daddr 10.0.2.3 udp dport 53 accept
  ip daddr 10.0.2.3 tcp dport 53 accept
  ip daddr @restricted4 counter name denied4 reject
  ip daddr @host4 counter name denied4 reject
  meta nfproto ipv6 counter name denied6 reject
  meta nfproto ipv4 accept
 }}
}}\n'''


class NetworkOwner:
    """Explicitly constructed experimental owner, finite and context-scoped.

    Application integration is deliberately absent. validate() is a trusted
    caller callback, rechecked before launches and every 50ms while alive.
    """
    _slots = threading.BoundedSemaphore(2)

    def __init__(self, *, session, workspace, helper, validate, lifetime=30, scratch_parent=None, network_policy="standard_outbound"):
        if network_policy not in ("public_only_fixture", "standard_outbound", "trusted_development"):
            raise NetworkError("NETWORK_POLICY_INVALID")
        self.network_policy = network_policy
        if not isinstance(session, str) or not session or not callable(validate):
            raise NetworkError('NETWORK_AUTHORIZATION_DENIED')
        # B2-D: cap owner safety lifetime just beyond B1's 30-minute command
        # maximum. Individual command deadlines remain separately enforced.
        if not 1 <= lifetime <= 1830:
            raise NetworkError('NETWORK_LIFETIME_INVALID')
        self.scratch_parent = scratch_parent
        self.session = session
        self.workspace = str(pathlib.Path(workspace).resolve(strict=True))
        if not pathlib.Path(self.workspace).is_dir() or self.workspace == '/':
            raise NetworkError('NETWORK_WORKSPACE_INVALID')
        self.validate = validate
        root_stat = os.stat(self.workspace)
        self._workspace_identity = (root_stat.st_dev, root_stat.st_ino)
        self.lifetime = lifetime
        try:
            self.helper_path = str(pathlib.Path(helper).resolve(strict=True))
        except OSError as error:
            raise NetworkError('NETWORK_BACKEND_UNAVAILABLE') from error
        self.closed = False
        self.ready = False
        self.reason = None
        self.cleanup_errors = []
        self._lock = threading.RLock()
        self._fds = []
        self._processes = []
        self._members = []
        self._scratch = None
        self._watch = None
        self._slot = False
        self._stop = threading.Event()
        self._started = False

    def _fd(self, fd):
        self._fds.append(fd)
        return fd

    def _drop_fd(self, fd):
        if fd in self._fds:
            self._fds.remove(fd)
            os.close(fd)

    def _spawn(self, argv, *, pass_fds=(), stdin=subprocess.DEVNULL, resource_limits=limits):
        p = subprocess.Popen(argv, stdin=stdin, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=ENV, pass_fds=pass_fds,
                             start_new_session=True, preexec_fn=resource_limits)
        self._processes.append(p)
        return p

    def _enter(self):
        return ['/usr/bin/nsenter', f'--user=/proc/self/fd/{self.user_fd}',
                '--preserve-credentials', f'--net=/proc/self/fd/{self.net_fd}']

    def _trusted(self, argv, text=None):
        p = subprocess.run(self._enter() + argv, pass_fds=(self.net_fd, self.user_fd),
                           input=text, text=True, capture_output=True, timeout=5, env=ENV)
        if p.returncode:
            raise NetworkError('NETWORK_POLICY_SETUP_FAILED', p.stderr)
        return p.stdout

    def start(self):
        if self._started or self.closed:
            raise NetworkError('NETWORK_OWNER_ALREADY_STARTED_OR_CLOSED')
        self._started = True
        try:
            self.validate()
            binary_fd = self._fd(os.open(self.helper_path, os.O_RDONLY | os.O_NOFOLLOW))
            if not stat.S_ISREG(os.fstat(binary_fd).st_mode):
                raise NetworkError('NETWORK_HELPER_IDENTITY_MISMATCH')
            with os.fdopen(os.dup(binary_fd), 'rb') as executable:
                digest = hashlib.file_digest(executable, 'sha256').hexdigest()
            if digest != HELPER_SHA256:
                raise NetworkError('NETWORK_HELPER_IDENTITY_MISMATCH')
            if not self._slots.acquire(blocking=False):
                raise NetworkError('NETWORK_OWNER_LIMIT')
            self._slot = True
            self._scratch = tempfile.TemporaryDirectory(prefix='continuum-b2c-', dir=self.scratch_parent)
            self.directory = pathlib.Path(self._scratch.name)
            self.resolver = self.directory / 'resolv.conf'
            self.resolver.write_text('nameserver 10.0.2.3\noptions timeout:1 attempts:1\n')
            # Subscribe BEFORE snapshot. Any host link/address/route change
            # invalidates the owner instead of retaining stale host-IP grants.
            self._watch = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE)
            self._watch.bind((0, 1 | 0x10 | 0x40 | 0x100 | 0x400))
            self._watch.settimeout(.05)
            host = json.loads(subprocess.check_output(['/usr/sbin/ip', '-j', 'address'], env=ENV, timeout=3))
            host4 = [a['local'] for entry in host for a in entry['addr_info'] if a['family'] == 'inet']
            # The trusted owner maps host UID/GID to namespace 0, unlike the
            # app's child userns. stdin EOF is the lifetime/control authority.
            owner_code = 'import os,sys; print(os.getpid(),flush=True); sys.stdin.buffer.read(1)'
            self.owner = self._spawn(['/usr/bin/unshare', '--user', '--map-root-user', '--net',
                                      '/usr/bin/python3', '-c', owner_code], stdin=subprocess.PIPE)
            pid = int(read_ready(self.owner.stdout.fileno()))
            self.net_fd = self._fd(os.open(f'/proc/{pid}/ns/net', os.O_RDONLY))
            self.user_fd = self._fd(fcntl.ioctl(self.net_fd, 0xb701))
            if os.fstat(self.net_fd).st_ino == os.stat('/proc/self/ns/net').st_ino:
                raise NetworkError('NETWORK_NAMESPACE_NOT_ISOLATED')
            # Install policy atomically BEFORE giving the namespace a TAP or
            # exposing any command-launch operation. No host nft invocation.
            self._rules = rules(host4, self.network_policy)
            self._trusted(['/usr/sbin/nft', '-f', '-'], self._rules)
            # Retain only the controller's ends after spawning the helper.
            rr, rw = os.pipe()
            er, ew = os.pipe()
            for fd in (rr, rw, er, ew):
                self._fd(fd)
            self.exit_fd = ew
            # Enter only the owner USER namespace for the trusted transport.
            # It retains host networking to translate TAP packets, not to run
            # workspace code. Root mapping fixes slirp's setegid(0) assumption.
            prefix = ['/usr/bin/nsenter', f'--user=/proc/self/fd/{self.user_fd}', '--preserve-credentials']
            self.helper = self._spawn(prefix + [f'/proc/self/fd/{binary_fd}', '--configure', '--disable-host-loopback',
                '--enable-sandbox', '--enable-seccomp', '--mtu=1500',
                f'--ready-fd={rw}', f'--exit-fd={er}', '--netns-type=path',
                f'--userns-path=/proc/self/fd/{self.user_fd}', f'/proc/self/fd/{self.net_fd}', 'tap0'],
                pass_fds=(self.user_fd, self.net_fd, binary_fd, rw, er))
            self._drop_fd(rw)
            self._drop_fd(er)
            if read_ready(rr) != b'1':
                diagnostic = ''
                with selectors.DefaultSelector() as sel:
                    sel.register(self.helper.stderr, selectors.EVENT_READ)
                    if sel.select(0):
                        diagnostic = os.read(self.helper.stderr.fileno(), 1024).decode(errors='replace')
                raise NetworkError('NETWORK_HELPER_SETUP_FAILED', diagnostic)
            self._drop_fd(rr)
            # External IPv6 is explicitly unsupported and filtered, rather
            # than relying on an absent route to claim a security boundary.
            self._trusted(['/usr/sbin/ip', '-6', 'address', 'add', 'fd00::100/64', 'dev', 'tap0'])
            self._trusted(['/usr/sbin/ip', '-6', 'route', 'add', 'default', 'dev', 'tap0'])
            self.validate()
            # Queued changes during initialization also fail closed.
            with selectors.DefaultSelector() as sel:
                sel.register(self._watch, selectors.EVENT_READ)
                if sel.select(0):
                    raise NetworkError('NETWORK_HOST_CONFIGURATION_CHANGED')
            self.ready = True
            self._deadline = time.monotonic() + self.lifetime
            self._monitor = threading.Thread(target=self._monitor_loop, daemon=True)
            self._monitor.start()
            return self
        except Exception:
            self.close('startup_failed')
            raise

    def _monitor_loop(self):
        while not self._stop.is_set():
            try:
                self.validate()
                root_stat = os.stat(self.workspace)
                if (root_stat.st_dev, root_stat.st_ino) != self._workspace_identity:
                    raise NetworkError('NETWORK_WORKSPACE_REPLACED')
                if time.monotonic() >= self._deadline:
                    self.close('expired')
                    return
                if self.owner.poll() is not None or self.helper.poll() is not None:
                    self.close('network_process_exited')
                    return
                try:
                    if self._watch.recv(65536):
                        self.close('host_network_changed')
                        return
                except socket.timeout:
                    pass
            except Exception:
                if not self.closed:
                    self.close('authorization_or_monitor_failed')
                return

    def _authorize(self, session, workspace):
        if self.closed or not self.ready:
            raise NetworkError('NETWORK_OWNER_UNAVAILABLE')
        self.validate()
        root_stat = os.stat(self.workspace)
        if (root_stat.st_dev, root_stat.st_ino) != self._workspace_identity:
            raise NetworkError('NETWORK_WORKSPACE_REPLACED')
        if session != self.session or str(pathlib.Path(workspace).resolve(strict=True)) != self.workspace:
            raise NetworkError('NETWORK_AUTHORIZATION_DENIED')

    def launch(self, session, workspace, argv):
        """Trusted fixture entry only. Never exported as an agent operation."""
        with self._lock:
            self._authorize(session, workspace)
            self._members = [p for p in self._members if p.poll() is None]
            if len(self._members) >= 4:
                raise NetworkError('NETWORK_COMMAND_LIMIT')
            if len(self._processes) >= 130:
                raise NetworkError('NETWORK_COMMAND_HISTORY_LIMIT')
            # Use the unchanged production filesystem planner in a fresh node
            # process with explicit disposable configuration (no Electron/DB).
            planner = pathlib.Path(__file__).resolve().parents[1] / 'sandboxFilesystem.js'
            script = '''const f=require(process.argv[1]);const w=process.argv[2];
const p=f.resolveFilesystem({workspace:w,protectGitMetadata:true,config:{appDataDirectory:process.argv[3]},userData:process.argv[3],hostEnv:{PATH:'/usr/bin:/bin'}});process.stdout.write(JSON.stringify(p));'''
            try:
                planned = subprocess.run(['/usr/bin/node', '-e', script, str(planner),
                                         self.workspace, str(self.directory)], timeout=5,
                                        env=ENV, capture_output=True, text=True)
                if planned.returncode:
                    raise NetworkError('NETWORK_FILESYSTEM_PREPARATION_FAILED', planned.stderr)
                plan = json.loads(planned.stdout)
            except subprocess.TimeoutExpired as error:
                raise NetworkError('NETWORK_FILESYSTEM_PREPARATION_TIMEOUT') from error
            mounts = plan['mounts']
            # network:false production plan omits resolver; add only the
            # owner's read-only synthetic DNS transport configuration here.
            mounts[-2:-2] = ['--ro-bind', str(self.resolver), '/etc/resolv.conf']
            command = self._enter() + ['/usr/bin/bwrap', '--die-with-parent', '--unshare-user',
                '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session', '--cap-drop', 'ALL',
                *mounts, '--clearenv', '--setenv', 'PATH', plan['env']['PATH'],
                '--setenv', 'HOME', '/sandbox-home', '--chdir', self.workspace,
                '/usr/bin/python3', '-I', '-c', '''import os,sys
for name in os.listdir('/proc/self/fd'):
 fd=int(name)
 if fd>2:
  try: os.close(fd)
  except OSError: pass
os.execvpe(sys.argv[1],sys.argv[1:],os.environ)
''', *argv]
            p = self._spawn(command, pass_fds=(self.net_fd, self.user_fd))
            self._members.append(p)
            return p

    def run(self, session, workspace, argv, timeout=8):
        p = self.launch(session, workspace, argv)
        output = {p.stdout: bytearray(), p.stderr: bytearray()}
        deadline = time.monotonic() + min(timeout, self.lifetime)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(p.stdout, selectors.EVENT_READ)
                selector.register(p.stderr, selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise NetworkError('NETWORK_COMMAND_TIMEOUT')
                    for key, _ in selector.select(min(.1, remaining)):
                        chunk = os.read(key.fileobj.fileno(), 4096)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        buffer = output[key.fileobj]
                        limit = 16384 if key.fileobj == p.stdout else 4096
                        if len(buffer) + len(chunk) > limit:
                            raise NetworkError('NETWORK_OUTPUT_LIMIT')
                        buffer.extend(chunk)
            p.wait(timeout=max(.01, deadline - time.monotonic()))
            return p.returncode, output[p.stdout].decode(errors='replace'), output[p.stderr].decode(errors='replace')
        except (subprocess.TimeoutExpired, NetworkError):
            self._kill(p)
            raise
        finally:
            p.stdout.close()
            p.stderr.close()

    @staticmethod
    def _kill(p):
        if p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                p.wait(timeout=.5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                p.wait(timeout=2)

    def close(self, reason='application_shutdown'):
        with self._lock:
            if self.closed:
                return
            self.closed = True
            self.ready = False
            self.reason = reason
            self._stop.set()
            for p in reversed(self._processes):
                try:
                    self._kill(p)
                except Exception as error:
                    self.cleanup_errors.append(type(error).__name__)
                for stream in (p.stdin, p.stdout, p.stderr):
                    if stream:
                        stream.close()
            for fd in list(self._fds):
                self._drop_fd(fd)
            if self._watch:
                self._watch.close()
            if self._scratch:
                self._scratch.cleanup()
            if self._slot:
                self._slots.release()
                self._slot = False

    def __enter__(self):
        return self.start()

    def __exit__(self, *_):
        self.close()
