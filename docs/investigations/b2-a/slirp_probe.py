#!/usr/bin/env python3
"""Bounded slirp feasibility tests. Supply an already verified helper path.

No download/install logic. Tests only public HTTPS and our own local sentinels.
This intentionally tests a transport WITHOUT a private-address policy: a
reachable private sentinel is a security finding, not a passing policy test.
"""
import fcntl
import hashlib
import http.server
import ipaddress
import json
import os
import pathlib
import resource
import secrets
import selectors
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time


def bounded_child():
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))


def wait_fd(fd, seconds=5):
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        if not selector.select(seconds):
            raise RuntimeError('readiness timeout')
        return os.read(fd, 8192)


def main(binary):
    processes, fds, sentinels = [], [], []
    result = {'backend_sha256': hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest()}
    marker = secrets.token_hex(16)
    try:
        with tempfile.TemporaryDirectory(prefix='continuum-b2-a-') as scratch:
            os.chmod(scratch, 0o700)
            resolver = pathlib.Path(scratch, 'resolv.conf')
            resolver.write_text('nameserver 10.0.2.3\noptions timeout:1 attempts:1\n')
            api = str(pathlib.Path(scratch, 'api.sock'))
            mounts = ['--tmpfs', '/', '--tmpfs', '/tmp']
            for entry in ['/usr', '/bin', '/lib', '/lib64']:
                if os.path.islink(entry):
                    mounts += ['--symlink', os.readlink(entry), entry]
                elif os.path.exists(entry):
                    mounts += ['--ro-bind', entry, entry]
            for entry in ['/etc/ld.so.cache', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/ssl/certs']:
                if os.path.exists(entry):
                    mounts += ['--ro-bind', entry, entry]
            mounts += ['--ro-bind', str(resolver), '/etc/resolv.conf',
                       '--proc', '/proc', '--dev', '/dev', '--remount-ro', '/']
            read_fd, write_fd = os.pipe()
            fds += [read_fd, write_fd]
            code = (
                'import http.server\n'
                'class H(http.server.BaseHTTPRequestHandler):\n'
                f' def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write({marker.encode()!r})\n'
                ' def log_message(self,*args): pass\n'
                'http.server.HTTPServer(("0.0.0.0",43119),H).serve_forever()\n'
            )
            owner = subprocess.Popen([
                'bwrap', '--die-with-parent', '--new-session', '--unshare-user',
                '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net',
                '--cap-drop', 'ALL', '--info-fd', str(write_fd), *mounts,
                '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
                '/usr/bin/python3', '-c', code,
            ], pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                preexec_fn=bounded_child)
            processes.append(owner)
            os.close(write_fd)
            fds.remove(write_fd)
            pid = json.loads(wait_fd(read_fd))['child-pid']
            net_fd = os.open(f'/proc/{pid}/ns/net', os.O_RDONLY)
            fds.append(net_fd)
            user_fd = fcntl.ioctl(net_fd, 0xb701)
            fds.append(user_fd)
            namespace_fds = [net_fd, user_fd]
            enter = ['nsenter', f'--user=/proc/self/fd/{user_fd}', '--preserve-credentials',
                     f'--net=/proc/self/fd/{net_fd}']
            # Helper keeps the host-side egress sockets; joins only the target
            # for TAP setup. The control socket is not mounted into the guest.
            ready_r, ready_w = os.pipe()
            exit_r, exit_w = os.pipe()
            fds += [ready_r, ready_w, exit_r, exit_w]
            helper = subprocess.Popen([
                binary, '--configure', '--disable-host-loopback', '--enable-ipv6',
                '--enable-seccomp', '--mtu=1500',
                f'--ready-fd={ready_w}', f'--exit-fd={exit_r}',
                '--api-socket', api, '--netns-type=path',
                f'--userns-path=/proc/self/fd/{user_fd}', f'/proc/self/fd/{net_fd}', 'tap0',
            ], pass_fds=(*namespace_fds, ready_w, exit_r),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=bounded_child)
            processes.append(helper)
            os.close(ready_w)
            fds.remove(ready_w)
            os.close(exit_r)
            fds.remove(exit_r)
            if wait_fd(ready_r) != b'1':
                raise RuntimeError('slirp did not signal readiness')
            result['helper_ready_seccomp_ipv6'] = True
            result['helper_mount_sandbox_enabled'] = False

            def run(argv, timeout=8, guest_fs=False):
                prefix = list(enter)
                if guest_fs:
                    # New mount/user/PID sandbox inherits only the explicitly
                    # joined isolated network, never the host network.
                    prefix += ['bwrap', '--die-with-parent', '--unshare-user',
                               '--unshare-pid', '--cap-drop', 'ALL', *mounts,
                               '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin']
                value = subprocess.run(prefix + argv, pass_fds=namespace_fds,
                                       capture_output=True, timeout=timeout,
                                       env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
                return {'exit': value.returncode, 'stdout': value.stdout[:2048].decode(errors='replace'),
                        'stderr': value.stderr[:512].decode(errors='replace')}

            def curl(url, guest_fs=False):
                return run(['curl', '--noproxy', '*', '--silent', '--show-error',
                            '--max-time', '3', '--connect-timeout', '2', '--max-filesize', '4096',
                            '--output', '/dev/null', '--write-out', '%{http_code}', url], guest_fs=guest_fs)

            result['dns_in_fresh_filesystem_sandbox'] = run(
                ['python3', '-c', 'import socket; print(bool(socket.getaddrinfo("example.com",443)))'],
                guest_fs=True)
            result['https_in_fresh_filesystem_sandbox'] = curl('https://example.com', guest_fs=True)
            result['subsequent_command_server'] = curl('http://127.0.0.1:43119', guest_fs=True)
            result['host_home_hidden_in_fresh_sandbox'] = run(
                ['python3', '-c', 'import os; assert not os.path.exists("/home/mk_saadi/.ssh"); print("hidden")'],
                guest_fs=True)

            class Sentinel(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'controlled-b2-a-sentinel')

                def log_message(self, *args):
                    pass

            def sentinel(address, ipv6=False):
                cls = http.server.HTTPServer
                if ipv6:
                    class V6(http.server.HTTPServer):
                        address_family = socket.AF_INET6
                    cls = V6
                server = cls((address, 0), Sentinel)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                sentinels.append((server, thread))
                target = f'[{address}]' if ipv6 else address
                check = subprocess.run(['curl', '--noproxy', '*', '-sS', '--max-time', '2',
                                        f'http://{target}:{server.server_port}'],
                                       capture_output=True, timeout=3)
                assert check.returncode == 0 and check.stdout == b'controlled-b2-a-sentinel'
                return server.server_port

            port4 = sentinel('127.0.0.1')
            result['loopback_v4_direct'] = curl(f'http://127.0.0.1:{port4}')
            result['loopback_v4_gateway_alias'] = curl(f'http://10.0.2.2:{port4}')
            result['loopback_v4_mapped_ipv6'] = curl(f'http://[::ffff:127.0.0.1]:{port4}')
            # Upstream explicitly warns the DNS alias may expose the host's
            # loopback resolver beyond DNS. Probe our own sentinel, not DNS/admin.
            try:
                dns_port = sentinel('127.0.0.53')
                result['loopback_dns_alias_non_dns_port'] = curl(f'http://10.0.2.3:{dns_port}')
            except OSError as error:
                result['loopback_dns_alias_non_dns_port'] = {'unavailable': error.errno}
            try:
                port6 = sentinel('::1', True)
                result['loopback_v6_direct'] = curl(f'http://[::1]:{port6}')
                result['loopback_v6_gateway_alias'] = curl(f'http://[fd00::2]:{port6}')
                result['loopback_v6_dns_alias'] = curl(f'http://[fd00::3]:{port6}')
            except OSError as error:
                result['loopback_v6'] = {'unavailable': error.errno}
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as routing:
                routing.connect(('1.1.1.1', 443))  # Route lookup only; sends no packet.
                local_address = routing.getsockname()[0]
            if ipaddress.ip_address(local_address).is_private:
                port_private = sentinel(local_address)
                result['own_host_private_address_sentinel'] = curl(f'http://{local_address}:{port_private}')
                result['own_host_private_address_mapped_ipv6'] = curl(f'http://[::ffff:{local_address}]:{port_private}')
            else:
                result['own_host_private_address_sentinel'] = {'not_tested': 'host route address is not private'}

            def control(command):
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
                    channel.settimeout(3)
                    channel.connect(api)
                    channel.sendall(json.dumps(command).encode())
                    channel.shutdown(socket.SHUT_WR)
                    return json.loads(channel.recv(4096))

            # Obtain an ephemeral candidate; API bind is final authority. Keep
            # a held listener to verify collisions are rejected, then retry.
            with socket.socket() as held:
                held.bind(('127.0.0.1', 0))
                held.listen(1)
                port = held.getsockname()[1]
                request = {'execute': 'add_hostfwd', 'arguments': {
                    'proto': 'tcp', 'host_addr': '127.0.0.1', 'host_port': port,
                    'guest_addr': '10.0.2.100', 'guest_port': 43119}}
                result['preview_collision_rejected'] = 'error' in control(request)
            response = control(request)
            if 'error' in response:
                raise RuntimeError('preview setup failed: ' + str(response))
            preview_id = response['return']['id']
            preview_url = f'http://127.0.0.1:{port}'

            def host_fetch():
                return subprocess.run(['curl', '--noproxy', '*', '-sS', '--max-time', '2',
                                       preview_url], capture_output=True, timeout=3)

            response = host_fetch()
            result['native_loopback_forward_verified'] = response.returncode == 0 and response.stdout == marker.encode()
            time.sleep(.15)
            result['preview_survives_command_completion'] = host_fetch().stdout == marker.encode()
            control({'execute': 'remove_hostfwd', 'arguments': {'id': preview_id}})
            result['preview_removed_unreachable'] = host_fetch().returncode != 0
            response = control(request)
            assert 'return' in response
            # Owner exit does NOT automatically kill a pinned namespace helper.
            owner.terminate()
            owner.wait(timeout=3)
            result['helper_remains_after_owner_exit_requires_cleanup'] = helper.poll() is None
            os.close(exit_w)
            fds.remove(exit_w)
            helper.wait(timeout=3)
            result['helper_exit_fd_reaped'] = helper.returncode == 0
            result['preview_closed_on_helper_exit'] = host_fetch().returncode != 0
            result['host_sentinels_positive_controls_verified'] = True
            result['owner_and_helper_reaped'] = owner.poll() is not None and helper.poll() is not None
            print(json.dumps(result, indent=2))
    finally:
        for server, thread in sentinels:
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            diagnostic = process.stderr.read(2048)
            if diagnostic:
                print(diagnostic.decode(errors='replace'), file=sys.stderr)
        for fd in fds:
            os.close(fd)


if __name__ == '__main__':
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('probe deadline')))
    signal.alarm(60)
    main(os.path.abspath(sys.argv[1]))
