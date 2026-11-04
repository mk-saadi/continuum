"""Trusted pipe-only connector, entered into an existing owner's network.

Arguments originate only in networkExecutionWorker, never a model. No listener,
no forwarding socket, no workspace code, no retained namespace descriptors.
"""
import os
import pathlib
import selectors
import socket
import sys
import time


def descendants(root):
    found = {root}
    # bwrap's PID namespace descendants still have host PIDs in this procfs.
    parents = {}
    for p in pathlib.Path('/proc').iterdir():
        if p.name.isdigit():
            try:
                fields = (p / 'stat').read_text().rsplit(')', 1)[1].split()
                parents[int(p.name)] = int(fields[1])
            except (OSError, ValueError, IndexError):
                pass
    for _ in range(64):
        added = {pid for pid, parent in parents.items() if parent in found} - found
        if not added:
            break
        found.update(added)
    return found


def owns_connection(root, local_port, remote_port):
    # Check the established SERVER socket, not merely the listening port.
    # A port rebound by a different command cannot inherit this authority.
    inodes = set()
    for name in ('tcp', 'tcp6'):
        address = '0100007F' if name == 'tcp' else '0000000000000000FFFF00000100007F'
        for line in pathlib.Path('/proc/net/' + name).read_text().splitlines()[1:]:
            fields = line.split()
            if (fields[1].split(':')[0] == address and fields[2].split(':')[0] == address
                    and fields[3] == '01' and int(fields[1].split(':')[1], 16) == remote_port
                    and int(fields[2].split(':')[1], 16) == local_port):
                inodes.add('socket:[' + fields[9] + ']')
    for pid in descendants(root):
        try:
            for fd in pathlib.Path(f'/proc/{pid}/fd').iterdir():
                try:
                    if os.readlink(fd) in inodes:
                        return True
                except OSError:
                    pass
        except OSError:
            pass
    return False


def main():
    root, port = map(int, sys.argv[1:])
    for fd in list(pathlib.Path('/proc/self/fd').iterdir()):
        if int(fd.name) > 2:
            try:
                os.close(int(fd.name))
            except OSError:
                pass
    sock = socket.create_connection(('127.0.0.1', port), timeout=2)
    deadline = time.monotonic() + 2
    while not owns_connection(root, sock.getsockname()[1], port):
        if time.monotonic() >= deadline:
            raise PermissionError('guest connection not owned by command')
        time.sleep(.02)
    os.write(1, b'1')
    sock.settimeout(None)
    # Kernel pipes provide bounded backpressure; controller EOF closes upstream.
    with selectors.DefaultSelector() as selector:
        selector.register(0, selectors.EVENT_READ)
        selector.register(sock, selectors.EVENT_READ)
        while True:
            for key, _ in selector.select(30):
                data = os.read(0, 16384) if key.fileobj == 0 else sock.recv(16384)
                if not data:
                    return
                if key.fileobj == 0:
                    sock.sendall(data)
                else:
                    view = memoryview(data)
                    while view:
                        view = view[os.write(1, view):]


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)  # No paths, process identity or credentials on error output.
