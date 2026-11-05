"""Private main-process transport, not a CLI tool for model/workspace use.

No PID, namespace path, shell profile or mode is accepted from a command.
The private pipe carries main-process-verified immutable argv envelopes.
Not packaged/enabled until the B2-D readiness gates have been resolved.
"""
import base64
import queue
import resource
import importlib.util
import json
import os
import pathlib
import selectors
import shutil
import signal
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True
source = pathlib.Path(__file__).parent / 'experimental/network_owner.py'
spec = importlib.util.spec_from_file_location('network_owner', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
lock = threading.Lock()
members = {}
cancelled = set()
owner = None
scratch = None
bridges = {}


def emit(value):
    with lock:
        print(json.dumps(value), flush=True)


def verify_development_budget():
    # Read the kernel's actual placement, never a caller-selected cgroup path.
    membership = pathlib.Path('/proc/self/cgroup').read_text().strip()
    scope = membership.rsplit('/', 1)[-1]
    if (not membership.startswith('0::/') or '\n' in membership
            or not scope.startswith('run-') or not scope.endswith('.scope')):
        raise module.NetworkError('NETWORK_RESOURCE_CONTAINMENT_UNAVAILABLE')
    group = pathlib.Path('/sys/fs/cgroup') / membership[4:]
    try:
        memory = int((group / 'memory.max').read_text())
        swap = int((group / 'memory.swap.max').read_text())
        tasks = int((group / 'pids.max').read_text())
        quota, period = map(int, (group / 'cpu.max').read_text().split())
        if not (0 < memory <= 1073741824 and swap == 0 and 0 < tasks <= 128
                and 0 < quota <= 2 * period):
            raise ValueError('unbounded scope')
        # Only after verifying our bounded disposable scope; never modify
        # ancestor controls or an ordinary application's unbounded scope.
        (group / 'memory.oom.group').write_text('1')
        if int((group / 'memory.oom.group').read_text()) != 1:
            raise ValueError('group OOM unavailable')
    except (OSError, ValueError):
        raise module.NetworkError('NETWORK_RESOURCE_CONTAINMENT_UNAVAILABLE')


def command_limits():
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    resource.setrlimit(resource.RLIMIT_AS, (64 * 1024**4,) * 2)


def execute(request):
    process = None
    try:
        with owner._lock:
            owner._authorize(request['session'], request['workspace'])
            launch = request['launch']
            if launch['file'] != '/usr/bin/bwrap' or request['id'] in cancelled:
                raise module.NetworkError('NETWORK_COMMAND_CANCELLED_OR_INVALID')
            # The verified argv is immutable in the controller. The worker
            # supplies namespace handles privately; there is no host-shell path.
            process = owner._spawn(owner._enter() + [launch['file'], *launch['argv']],
                                   pass_fds=(owner.net_fd, owner.user_fd), resource_limits=command_limits)
            members[request['id']] = process
            owner._members.append(process)
        emit({'event': 'running', 'id': request['id']})
        deadline = time.monotonic() + request['timeoutMs'] / 1000
        status = None
        with selectors.DefaultSelector() as selector:
            for stream, name in ((process.stdout, 'stdout'), (process.stderr, 'stderr')):
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    status = 'timed_out'
                    owner._kill(process)
                if owner.closed:
                    status = 'cancelled'
                    owner._kill(process)
                if request['id'] in cancelled:
                    status = 'cancelled'
                    owner._kill(process)
                for key, _ in selector.select(.05):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        emit({'event': 'data', 'id': request['id'], 'stream': key.data,
                              'text': chunk.decode(errors='replace')})
        code = process.wait(timeout=2)
        for identifier, bridge in list(bridges.items()):
            if bridge.get('command') == request['id']:
                close_bridge(identifier)
        emit({'event': 'done', 'id': request['id'], 'exitCode': code if code >= 0 else None,
              'signal': signal.Signals(-code).name if code < 0 else None,
              'status': status or ('completed' if code == 0 else 'nonzero_exit')})
    except Exception as error:
        if process:
            owner._kill(process)
        emit({'event': 'failed', 'id': request.get('id'), 'code': getattr(error, 'code', 'NETWORK_COMMAND_FAILED')})
    finally:
        if process:
            for stream in (process.stdout, process.stderr):
                stream.close()
            with owner._lock:
                if process in owner._members:
                    owner._members.remove(process)
                if process in owner._processes:
                    owner._processes.remove(process)
        members.pop(request.get('id'), None)
        cancelled.discard(request.get('id'))


def close_bridge(identifier):
    bridge = bridges.pop(identifier, None)
    if bridge:
        bridge['ack'].set()
        try:
            bridge['input'].put_nowait(None)
        except queue.Full:
            pass
        if bridge.get('process'):
            owner._kill(bridge['process'])


def bridge_connection(request, bridge):
    identifier = request['id']
    process = None
    try:
        with owner._lock:
            command = members.get(request['command'])
            port = request['port']
            if not command or command.poll() is not None or type(port) is not int or not 1 <= port <= 65535:
                raise ValueError('invalid live command/port')
            owner._authorize(request['session'], request['workspace'])
            process = owner._spawn(owner._enter() + ['/usr/bin/python3', '-I',
                str(pathlib.Path(__file__).parent / 'networkPreviewBridge.py'), str(command.pid), str(port)],
                pass_fds=(owner.net_fd, owner.user_fd), stdin=subprocess.PIPE)
        bridge['process'] = process
        if identifier not in bridges or module.read_ready(process.stdout.fileno()) != b'1':
            raise ValueError('unverified endpoint')
        emit({'event': 'bridge_ready', 'id': identifier})

        def writer():
            try:
                while identifier in bridges:
                    data = bridge['input'].get()
                    if data is None:
                        break
                    process.stdin.write(data)
                    process.stdin.flush()
                    emit({'event': 'bridge_ack', 'id': identifier})
            except (OSError, ValueError):
                pass
            finally:
                owner._kill(process)
        threading.Thread(target=writer, daemon=True).start()
        while identifier in bridges and not owner.closed and command.poll() is None:
            data = os.read(process.stdout.fileno(), 16384)
            if not data:
                break
            bridge['ack'].clear()
            emit({'event': 'bridge_data', 'id': identifier, 'data': base64.b64encode(data).decode('ascii')})
            if not bridge['ack'].wait(30):
                break
    except Exception:
        pass
    finally:
        close_bridge(identifier)
        if process:
            owner._kill(process)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()
            with owner._lock:
                if process in owner._processes:
                    owner._processes.remove(process)
        emit({'event': 'bridge_end', 'id': identifier})


try:
    verify_development_budget()
    address_policy = json.loads((pathlib.Path(__file__).parent / 'workspaceNetworkAddressPolicy.json').read_text())
    module.SPECIAL4 = module.validate_address_policy(address_policy)
    control = sys.stdin.buffer.raw
    start = json.loads(control.readline(65536))
    if start.get('op') != 'start':
        raise module.NetworkError('NETWORK_START_REQUIRED')
    # The tier is decided in the app main process, not by command or renderer
    # input. Anything outside the two shipped tiers fails closed.
    policy = start.get('network_policy')
    if policy not in ('standard_outbound', 'trusted_development'):
        raise module.NetworkError('NETWORK_POLICY_INVALID')
    scratch = start['scratch']
    owner = module.NetworkOwner(session=start['session'], workspace=start['workspace'],
                                helper=start['helper'], validate=lambda: None, lifetime=1830, scratch_parent=scratch, network_policy=policy).start()
    emit({'event': 'ready', 'resolver': str(owner.resolver)})
    while not owner.closed:
        with selectors.DefaultSelector() as selector:
            selector.register(sys.stdin, selectors.EVENT_READ)
            if not selector.select(.05):
                continue
            line = control.readline(262145)
        if not line:
            break
        if len(line) > 262144:
            raise module.NetworkError('NETWORK_CONTROL_LIMIT')
        request = json.loads(line)
        if request['op'] == 'execute':
            if len(members) >= 4:
                raise module.NetworkError('NETWORK_COMMAND_LIMIT')
            members[request['id']] = None
            threading.Thread(target=execute, args=(request,), daemon=True).start()
        elif request['op'] == 'cancel':
            if request['id'] in members:
                cancelled.add(request['id'])
            process = members.get(request['id'])
            if process:
                owner._kill(process)
        elif request['op'] == 'bridge_open':
            if len(bridges) >= 32 or request['id'] in bridges:
                emit({'event': 'bridge_end', 'id': request['id']})
                continue
            bridge = {'ack': threading.Event(), 'input': queue.Queue(maxsize=1), 'command': request['command']}
            bridges[request['id']] = bridge
            threading.Thread(target=bridge_connection, args=(request, bridge), daemon=True).start()
        elif request['op'] == 'bridge_data':
            bridge = bridges.get(request['id'])
            if bridge:
                try:
                    if len(request['data']) > 21848:
                        raise ValueError('chunk limit')
                    data = base64.b64decode(request['data'], validate=True)
                    if not data or len(data) > 16384:
                        raise ValueError('chunk limit')
                    bridge['input'].put_nowait(data)
                except (ValueError, queue.Full):
                    close_bridge(request['id'])
        elif request['op'] == 'bridge_ack':
            bridge = bridges.get(request['id'])
            if bridge:
                bridge['ack'].set()
        elif request['op'] == 'bridge_close':
            close_bridge(request['id'])
        elif request['op'] == 'shutdown':
            break
        else:
            raise module.NetworkError('NETWORK_INVALID_OPERATION')
except Exception as error:
    emit({'event': 'fatal', 'code': getattr(error, 'code', 'NETWORK_BACKEND_FAILED')})
finally:
    if owner:
        for identifier in list(bridges):
            close_bridge(identifier)
        owner.close('controller_closed')
    if scratch:
        shutil.rmtree(scratch, ignore_errors=True)
