"""Exercise long-job worker limits and renewal without requiring namespaces."""
import ast
import pathlib
import threading
import types
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'src/main/networkExecutionWorker.py'


class LifetimeTests(unittest.TestCase):
    def worker(self):
        tree = ast.parse(SOURCE.read_text())
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name in ('command_limits', 'execute')]
        limits, events, launches = {}, [], []
        resource = types.SimpleNamespace(
            RLIMIT_NOFILE='files', RLIMIT_CORE='core', RLIMIT_CPU='cpu', RLIMIT_AS='memory',
            setrlimit=lambda key, value: limits.update({key: value}))

        class NetworkError(Exception):
            def __init__(self, code):
                self.code = code

        def spawn(*args, **kwargs):
            launches.append(args)
            kwargs['resource_limits']()
            # Stop before launching anything; everything before spawn is real.
            raise NetworkError('TEST_STOP_BEFORE_LAUNCH')

        owner = types.SimpleNamespace(
            _lock=threading.RLock(), _deadline=101, net_fd=1, user_fd=2,
            _authorize=lambda *args: None, _enter=lambda: [], _spawn=spawn)
        env = {'resource': resource, 'owner': owner, 'module': types.SimpleNamespace(NetworkError=NetworkError),
               'time': types.SimpleNamespace(monotonic=lambda: 100), 'cancelled': set(),
               'members': {}, 'emit': events.append}
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), 'exec'), env)
        return env, owner, limits, events, launches

    def test_cpu_budget_follows_wall_lifetime_instead_of_sixty_seconds(self):
        env, _, limits, _, _ = self.worker()
        env['command_limits'](3600000)
        self.assertEqual(limits['cpu'], (7230, 7230))
        self.assertEqual(limits['files'], (256, 256))
        env['command_limits'](86400000)
        self.assertEqual(limits['cpu'], (172830, 172830))

    def test_late_command_gets_its_full_lifetime_and_renews_network_owner(self):
        env, owner, limits, events, launches = self.worker()
        env['execute']({'id': 'long', 'session': 's', 'workspace': '/work',
                        'timeoutMs': 86400000, 'launch': {'file': '/usr/bin/bwrap', 'argv': []}})
        self.assertEqual(owner._deadline, 86530)
        self.assertEqual(len(launches), 1)
        self.assertEqual(limits['cpu'], (172830, 172830))
        self.assertEqual(events[-1]['code'], 'TEST_STOP_BEFORE_LAUNCH')

    def test_invalid_lifetimes_never_launch_or_renew(self):
        for value in (True, 0, -1, 86400001, '3600000', None):
            with self.subTest(value=value):
                env, owner, _, events, launches = self.worker()
                env['execute']({'id': 'bad', 'timeoutMs': value})
                self.assertEqual(launches, [])
                self.assertEqual(owner._deadline, 101)
                self.assertEqual(events[-1]['code'], 'NETWORK_COMMAND_LIFETIME_INVALID')

    def test_authoritative_subsecond_deadline_is_accepted(self):
        env, _, _, events, launches = self.worker()
        env['execute']({'id': 'deadline', 'session': 's', 'workspace': '/work',
                        'timeoutMs': 100, 'launch': {'file': '/usr/bin/bwrap', 'argv': []}})
        self.assertEqual(len(launches), 1)
        self.assertEqual(events[-1]['code'], 'TEST_STOP_BEFORE_LAUNCH')


if __name__ == '__main__':
    unittest.main()
