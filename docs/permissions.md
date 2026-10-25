# Contained execution filesystem

Contained shell and Git execution start with an empty bwrap root, not a read-only view of the host root. Both use `sandboxFilesystem.buildSandboxMounts` with authoritative inputs resolved by `resolveFilesystem`.

After all mounts are installed, the empty root scaffold is remounted read-only; only the explicit workspace and scratch mounts stay writable.

The system runtime directories `/usr`, `/bin`, `/sbin`, `/lib`, and `/lib64`, where present, are read-only; aliases retain their resolved symlink layout. Only these `/etc` runtime entries are admitted when present: `ld.so.cache`, `ld.so.conf`, `ld.so.conf.d`, `passwd`, `group`, `nsswitch.conf`, `localtime`, `ssl/certs`, `ca-certificates`, `mime.types`, `alternatives`. Git network execution additionally admits `resolv.conf` and `hosts`. Symlinked `/etc` entries are bound from their real source directly to their allowlisted destination, without exposing the source's parent directory.

The workspace is writable for shell and Git mutations and read-only for Git inspection. Continuum user data, configured app data (database, WAL and recovery), and `.llm_workspace` are masked with empty read-only mounts when exposed by another mount. Shell sandbox tmp/home are rebound only at `/tmp` and `/sandbox-home`; their original paths remain hidden. Git uses fresh temporary `/tmp` for HOME, and its explicit askpass directory is rebound read-only. `/proc` and `/dev` are freshly created. Host `/run`, `/mnt`, `/media`, home directories and general temporary files are not mounted. Filesystem sockets in the workspace or added runtime directories cause setup to fail; the host active Unix-socket table is also checked for sockets under every admitted runtime/mount source (including system trees). Abstract sockets are discussed below. These preflight checks do not eliminate concurrent filesystem replacement races.

Node/npm installations such as nvm are resolved to their real installation prefix and admitted read-only without mounting the rest of home. Volta and asdf are queried for their resolved runtime image; unresolved shims fail closed. Extra SDK/compiler paths can be added through **Settings → Directories → Extra read-only runtime paths**. Paths must exist, be absolute directories, and cannot be root, home/its ancestors, credential directories, protected application data/its ancestors, or host `/etc`, `/run`, `/mnt`, `/media`, `/proc`, `/dev`. Explicit runtime paths are trusted read exposure, not a place to keep secrets. Python virtual environments and compilers outside admitted paths require that explicit setting. External libraries, Git helpers and custom certificate paths may also need it. Ambient user/global Git configuration remains disabled.

Shell and contained Git environments admit only a constructed PATH, LANG, LC_*, TERM and TZ, plus fixed HOME/TMPDIR and Git's explicitly constructed settings/askpass helper. Ambient tokens, proxy configuration, NODE_OPTIONS and SSH agent sockets are not inherited. An unavailable runtime, invalid mount, missing bwrap or namespace error fails execution without host fallback.

Offline shell and Git inspection retain `--unshare-net`; they cannot access host TCP loopback or LAN listeners. Git remote execution shares the host network, including loopback and LAN, to support remote operations and the credential relay. This also means abstract Unix sockets in that network namespace are not isolated. Filesystem confidentiality does not make the network profile outbound-only.

## Residual risks

Workspace-resident secrets such as `.env`, project registry configuration and source credentials deliberately remain readable. Commands may print them. Before tool output enters model context (including history replay), the shared existing secret redactor removes recognized private-key blocks, credential/token patterns and labeled secrets, with additional long-token filtering. User cards retain original output and indicate when model content was redacted. Redaction is heuristic and cannot guarantee removal of every secret or encoded/transformed value.

The admitted system runtime trees are trusted and readable, including any locally installed content under `/usr`. Explicit runtime paths are also readable. Do not store credentials in runtime installation directories. Application-data masks take precedence over runtime/workspace mounts. Mount and socket checks are subject to host filesystem races; other processes should not mutate mount sources during launch.

Recovery preserves eligible workspace files around commands, subject to its documented exclusions and capture limits. It cannot undo disclosure to a model/network peer or restore all installed dependencies.

## Redaction boundaries

Tool results entering the parent model, replayed tool messages, child-agent tool results, and selected work-log digest fields use the shared secret redactor. Generic token filtering preserves recognized paths; explicit secret signatures still redact inside paths.

Rolling-summary generation, Workspace compact-candidate generation (including intermediate reductions), checkpoint generation, and memory injection do not have a shared secret-redaction pass. Child compaction inherits already-redacted tool text, but does not independently redact its other inputs. Replayed summaries are also not independently redacted. User-typed text and stored memory are user content; this tool-output safeguard does not rewrite them. Workspace compact candidates separately reject sensitive command metadata rather than silently changing exact evidence. These boundaries are outside the tool-output redaction scope.

Shell sandbox git metadata is read-only. After binding the workspace, the shell
profile overlays resolved `.git` directories and gitfiles, including linked
worktree gitdirs and common directories, read-only. Each invocation discovers
metadata again, so shell `git init` is protected on the next invocation.
`GIT_OPTIONAL_LOCKS=0` permits inspection without optional index refresh writes.
Git mutations must use the `git_*` tools, whose writable profile is unchanged.
File tools reject writes, patches, moves and deletes of git metadata, including
resolved aliases and moves of containing directories.

In Workspace Write, shell syntax and argument paths do not determine approval:
commands with pipes, expansions, embedded interpreters, URLs or absolute paths
run without a prompt when the selected bwrap/sandboxFilesystem profile is
available and cwd is inside the workspace. Package installation and publication
still require review. Invalid commands and cwd escapes are rejected; an
unavailable sandbox or uncontained execution requires review. Execution grants
remain specific and single-use. Dispatch rechecks cwd and requires the actual
registered filesystem plan, network isolation and sandbox executable before
launch; a missing or altered plan fails closed without a host fallback.
