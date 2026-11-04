"""Deterministic rejection of unsupported/ineffective cgroup resource budgets."""
import ast
import pathlib
import types
import unittest

source = pathlib.Path(__file__).resolve().parents[1] / 'src/main/networkExecutionWorker.py'
function = next(n for n in ast.parse(source.read_text()).body
                if isinstance(n, ast.FunctionDef) and n.name == 'verify_development_budget')


class ResourceTests(unittest.TestCase):
    def verify(self, overrides=None):
        values = {'/proc/self/cgroup': '0::/run-disposable.scope',
                  'memory.max': '1073741824', 'memory.swap.max': '0',
                  'pids.max': '128', 'cpu.max': '200000 100000', 'memory.oom.group': '0'}
        values.update(overrides or {})
        writes = []

        class Path:
            def __init__(self, name):
                self.name = str(name)

            def __truediv__(self, other):
                return Path(self.name + '/' + other)

            def read_text(self):
                value = values.get(self.name, values.get(self.name.rsplit('/', 1)[-1]))
                if value is None:
                    raise OSError('missing controller')
                return value

            def write_text(self, value):
                writes.append(self.name)
                values[self.name.rsplit('/', 1)[-1]] = value

        class Failure(Exception):
            pass

        namespace = {'pathlib': types.SimpleNamespace(Path=Path),
                     'module': types.SimpleNamespace(NetworkError=Failure)}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        namespace['verify_development_budget']()
        self.assertEqual(writes, ['/sys/fs/cgroup/run-disposable.scope/memory.oom.group'])

    def test_effective_kernel_budget(self):
        self.verify()

    def test_unbounded_missing_or_ineffective_controllers_fail_closed(self):
        for values in [{'memory.max': 'max'}, {'memory.max': '2147483648'},
                       {'memory.swap.max': '1'}, {'pids.max': 'max'}, {'pids.max': '129'},
                       {'cpu.max': 'max 100000'}, {'cpu.max': '300000 100000'},
                       {'memory.max': None}, {'/proc/self/cgroup': '1:memory:/legacy'}]:
            with self.subTest(values=values), self.assertRaises(Exception):
                self.verify(values)


if __name__ == '__main__':
    unittest.main(verbosity=2)
