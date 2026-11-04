#!/usr/bin/env python3
"""Disposable B2-A feasibility probe; not a production proxy or executor.

Run with python3 on Linux where bwrap, nsenter and curl can create sockets.
No downloads, root, host network sharing, or system configuration changes.
"""
import http.server
import fcntl
import json
import os
import secrets
import selectors
import subprocess
import threading
import time
import urllib.error
import urllib.request


def main():
    processes = []
    preview = None
    read_fd, write_fd = os.pipe()
    marker = secrets.token_hex(16)
    result = {}
    namespace_fds = []
    # Empty root and disposable scratch; this is a fixture mount plan, not
    # Continuum's production sandboxFilesystem verifier.
    mounts = ['--tmpfs', '/', '--tmpfs', '/tmp']
    for entry in ['/usr', '/bin', '/lib', '/lib64']:
        if os.path.islink(entry):
            mounts += ['--symlink', os.readlink(entry), entry]
        elif os.path.exists(entry):
            mounts += ['--ro-bind', entry, entry]
    for entry in ['/etc/ld.so.cache', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group']:
        if os.path.exists(entry):
            mounts += ['--ro-bind', entry, entry]
    mounts += ['--proc', '/proc', '--dev', '/dev', '--remount-ro', '/']
    server_code = (
        'import http.server,os\n'
        'assert not os.path.exists("/home/mk_saadi/.ssh")\n'
        'class H(http.server.BaseHTTPRequestHandler):\n'
        f' def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write({marker.encode()!r})\n'
        ' def log_message(self,*args): pass\n'
        'http.server.HTTPServer(("127.0.0.1",43119),H).serve_forever()\n'
    )
    try:
        owner = subprocess.Popen([
            'bwrap', '--die-with-parent', '--new-session', '--unshare-user',
            '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net',
            '--cap-drop', 'ALL', '--info-fd', str(write_fd), *mounts,
            '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
            '/usr/bin/python3', '-c', server_code,
        ], pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        processes.append(owner)
        os.close(write_fd)
        write_fd = None
        with selectors.DefaultSelector() as selector:
            selector.register(read_fd, selectors.EVENT_READ)
            if not selector.select(4):
                raise RuntimeError('namespace initialization timeout')
            info = json.loads(os.read(read_fd, 4096))
        pid = info['child-pid']
        host_net = os.readlink('/proc/self/ns/net')
        owner_net = os.readlink(f'/proc/{pid}/ns/net')
        assert owner_net != host_net
        result['network_distinct_from_host'] = True
        # PIDs here come only from our own freshly spawned bwrap info fd.
        # Production must retain namespace handles/pidfds to prevent reuse.
        net_fd = os.open(f'/proc/{pid}/ns/net', os.O_RDONLY)
        namespace_fds.append(net_fd)
        user_fd = fcntl.ioctl(net_fd, 0xb701)  # NS_GET_USERNS: actual network owner
        namespace_fds.append(user_fd)
        enter = ['nsenter', f'--user=/proc/self/fd/{user_fd}', '--preserve-credentials',
                 f'--net=/proc/self/fd/{net_fd}']
        joined = subprocess.run(enter + ['readlink', '/proc/self/ns/net'],
                                pass_fds=namespace_fds, capture_output=True, text=True, timeout=3)
        assert joined.returncode == 0 and joined.stdout.strip() == owner_net
        result['subsequent_command_same_namespace'] = True

        def fetch():
            response = subprocess.run(enter + [
                'curl', '--noproxy', '*', '--silent', '--show-error',
                '--fail', '--max-time', '2', '--max-filesize', '4096',
                'http://127.0.0.1:43119/',
            ], pass_fds=namespace_fds, capture_output=True, timeout=3)
            if response.returncode or response.stdout != marker.encode():
                raise RuntimeError('owned namespace destination unavailable: ' + response.stderr.decode(errors='replace')[:300])
            return response.stdout

        deadline = time.monotonic() + 4
        while True:
            try:
                fetch()
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.05)
        result['isolated_server_http_200'] = True
        result['fixture_hidden_host_home'] = True
        token = secrets.token_urlsafe(24)

        class Preview(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path != '/' + token:
                    self.send_error(403)
                    return
                try:
                    body = fetch()
                except (RuntimeError, subprocess.TimeoutExpired):
                    self.send_error(502)
                    return
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        # OS allocates a free host port; only one selected destination exists.
        preview = http.server.HTTPServer(('127.0.0.1', 0), Preview)
        address = preview.server_address
        thread = threading.Thread(target=preview.serve_forever, daemon=True)
        thread.start()
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        base = f'http://127.0.0.1:{address[1]}'
        with client.open(base + '/' + token, timeout=4) as response:
            assert response.status == 200 and response.read(4096) == marker.encode()
        result['host_loopback_selected_preview_http_200'] = True
        try:
            client.open(base + '/wrong-token', timeout=2)
            raise AssertionError('unauthenticated request accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 403
        result['preview_wrong_token_403'] = True
        # A foreground fetch ending does not end the independently owned server.
        time.sleep(.1)
        assert owner.poll() is None and fetch() == marker.encode()
        result['server_survives_subsequent_command_completion'] = True
        owner.terminate()
        owner.wait(timeout=3)
        preview.shutdown()
        preview.server_close()
        thread.join(timeout=2)
        preview = None
        try:
            client.open(base + '/' + token, timeout=1)
            raise AssertionError('preview survived teardown')
        except urllib.error.URLError:
            pass
        result['preview_closed_on_explicit_teardown'] = True
        result['outbound_backend_tested'] = False
        print(json.dumps(result, indent=2))
    finally:
        if preview:
            preview.shutdown()
            preview.server_close()
        for process in processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            error = process.stderr.read(2048)
            if error:
                print(error.decode(errors='replace'), file=__import__('sys').stderr)
        for fd in namespace_fds:
            os.close(fd)
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)


if __name__ == '__main__':
    # Bound the entire probe, including error paths, without a lasting daemon.
    import signal
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('probe deadline')))
    signal.alarm(25)
    main()
