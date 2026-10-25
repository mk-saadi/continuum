# Step 1b implementation report

No approval-policy changes. The characterization fixture remains byte-identical. Pre-existing uncommitted changes were kept out of the Step 1b commits.

## Builder API

`sandboxFilesystem.buildSandboxMounts({ system, etc, runtimes, workspace, writable, maskedPaths, home, tmp, askpassDirectory }) -> string[]` is pure. Runtime entries contain resolved `source`, `destination`, and optional `symlink` or `fileMapping` flags. It performs no filesystem I/O or process launch.

`resolveFilesystem({ workspace, network, writable, home, tmp, askpassDirectory, config, userData, hostEnv }) -> { mounts, env }` resolves and validates authoritative host inputs. It discovers executable installations, resolves Volta/asdf images, validates extra runtime paths, and rejects exposed filesystem sockets. `environment` constructs the environment allowlist; `validateExtraPaths` validates the app setting. Setup failures propagate without a host-shell fallback.

## Exact mount tables

The following is the resolved layout on this development host. Optional entries are omitted when absent. Other hosts use the same allowlist, resolving their own symlink targets and runtime prefixes.

Definitions:

- `W = /home/mk_saadi/projects/persona-projects/llm-electron` for this repository; each chat uses its own real workspace.
- `N = /home/mk_saadi/.nvm/versions/node/v22.23.4` here.
- `P = N/lib/node_modules/npm` here.
- `A` is configured `appDataDirectory`; `U` is Electron `userData`. They are read from the app at launch, not inferred from the app name.
- `H = W/.llm_workspace/sandbox/home`; `T = W/.llm_workspace/sandbox/tmp` (both verified workspace-contained by the caller).
- `Q = dirname(askpass helper)`; currently an `os.tmpdir()/git-askpass-<random>` directory.

Common ordered runtime mounts:

| Flag | Source | Destination |
| --- | --- | --- |
| `--tmpfs` | empty | `/` |
| `--tmpfs` | empty | `/tmp` |
| `--dir` | empty directory | `/sandbox-home` |
| `--ro-bind` | `/usr` | `/usr` |
| `--ro-bind` | `/usr/bin` | `/usr/bin` |
| `--symlink` | `/usr/bin` | `/bin` |
| `--ro-bind` | `/usr/sbin` | `/usr/sbin` |
| `--symlink` | `/usr/sbin` | `/sbin` |
| `--ro-bind` | `/usr/lib` | `/usr/lib` |
| `--symlink` | `/usr/lib` | `/lib` |
| `--ro-bind` | `/usr/lib64` | `/usr/lib64` |
| `--symlink` | `/usr/lib64` | `/lib64` |
| `--ro-bind` | `/etc/ld.so.cache` | same |
| `--ro-bind` | `/etc/ld.so.conf` | same |
| `--ro-bind` | `/etc/ld.so.conf.d` | same |
| `--ro-bind` | `/etc/passwd` | same |
| `--ro-bind` | `/etc/group` | same |
| `--ro-bind` | `/etc/nsswitch.conf` | same |
| `--ro-bind` | `/usr/share/zoneinfo/Asia/Dhaka` | `/etc/localtime` |
| `--ro-bind` | `/etc/ssl/certs` | same |
| `--ro-bind` | `/etc/ca-certificates` | same |
| `--ro-bind` | `/etc/mime.types` | same |
| `--ro-bind` | `/etc/alternatives` | same |
| `--ro-bind` | `N` | `N` |
| `--ro-bind` | `P` | `P` |

Each explicitly configured or otherwise discovered runtime prefix adds a read-only bind to its own absolute path. `/etc` symlink sources are bound directly to their allowlisted destination; source parent directories are not exposed. No whole `/etc`, home, `/run`, `/mnt`, `/media`, or host root mount exists.

Offline shell ordering/differences:

1. Immediately after initial root/tmp/home creation and **before runtime/workspace mounts**: `--bind T /tmp`. This ordering also supports workspaces located under `/tmp`.
2. Common runtime mounts above.
3. `--bind W W`.
4. For existing exposed `A`, `U`, and `W/.llm_workspace`: `--tmpfs <path> --remount-ro <path>`, after workspace binding. Nested masks collapse into their outermost mask. Paths already absent from the filesystem are not mounted. Unexposed data directories need no mask.
5. `--bind H /sandbox-home` (original `.llm_workspace` paths remain hidden).
6. `--proc /proc`, `--dev /dev`, `--remount-ro /`.

The namespace arguments retain `--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-net --cap-drop ALL`. HOME is `/sandbox-home`, TMPDIR is `/tmp`.

Git network ordering/differences:

1. Initial root/tmp/home creation, then common system and `/etc` mounts.
2. Before runtime-prefix binds: `--ro-bind /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf` and `--ro-bind /etc/hosts /etc/hosts` on this host. Only the resolver file is exposed; `/run` remains absent.
3. Runtime-prefix binds.
4. `--bind W W` for mutations or `--ro-bind W W` for inspection.
5. Same exposed-data masks as shell.
6. Conditional `--ro-bind Q Q` for the explicit credential relay helper.
7. `--proc /proc`, `--dev /dev`, `--remount-ro /`.

Git uses the fresh `/tmp` for HOME/TMPDIR and does not bind shell scratch storage. Git inspection omits resolver/hosts and retains `--unshare-net`. Git remote execution shares the host network, as before; loopback, LAN and abstract Unix sockets remain reachable. The authenticated localhost relay still works.

Both launch bwrap with a fixed system-only PATH. The runtime PATH is set **inside** bwrap through `--setenv PATH ...`, preventing a discovered runtime directory from replacing the host sandbox launcher.

## Changed behavior

- Absolute host-home reads, credential directories, application database/WAL/recovery reads, arbitrary host files and filesystem sockets are unavailable. Root/home-as-workspace configurations fail setup rather than exposing the whole host/home.
- nvm prefixes work without exposing the rest of home. Volta/asdf resolve the actual image; unresolved shims fail clearly. Additional Python venvs, SDKs, compilers, external libraries and custom Git helpers may need an explicit extra read-only runtime path.
- Ambient Git credentials, proxies, agent sockets, executable-injection variables and tokens are stripped. User/system Git configuration remains disabled. Signing/helpers requiring hidden keys/configuration can fail and need an explicit supported workflow.
- Model-facing tool results and history replay pass through shared secret redaction. User output stays original; the command card marks redaction. See `permissions.md` for workspace `.env` residual risk, heuristic-redaction limits and mount/socket races.

## Validation

- Combined regression matrix: **231 tests, 230 passed, 1 opt-in long-command test skipped, 0 failed**.
- Final focused filesystem/relay run after active-socket checking: **13 passed, 0 skipped, 0 failed**. This includes one additional socket-table test beyond the combined run.
- Actual authenticated HTTP bare-remote push/fetch through read-only askpass relay passed; offline loopback/LAN isolation passed.
- Node v22.23.4, npm 10.9.9, Python 3.12.3, shell, Git, dynamic libraries, locale and certificate availability verified inside the sandbox.
- Renderer production build passed. Electron directory-settings UI test passed, including runtime-path add/remove.
- Frozen characterization fixture hash verified unchanged. Existing approval, remembered-rule, native/MCP permissions, Git, execution, recovery and formatting suites passed.

Step 2 result metadata/failure notes and Step 3 install_packages are not implemented.
