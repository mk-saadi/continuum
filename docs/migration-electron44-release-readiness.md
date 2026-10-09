# Electron 44 migration — Phase 4C release readiness

> Historical phase report: artifact hashes, Git state and conclusions below describe that phase only. See [renderer sandbox validation and final review](migration-electron44-renderer-sandbox.md) for the final migration state, corrected UI outcomes and remaining release limits. The later preload consolidation enables and verifies the renderer sandbox on the development host; the sandbox blocker below applies to the older Phase 4C packages. Its install/inference checks have not been repeated on the final sandboxed packages.

Date: 2026-10-09 (Asia/Dhaka). **Recommendation: blocked for the requested sandboxed-renderer release verification.** Ordinary user startup/persistence, private Debian installation and essential transport checks pass, but the shipped main window explicitly disables its renderer sandbox. This is a pre-existing setting, not a new Electron 44 regression. Ubuntu 22.04 / Debian 12 execution and Wayland also remain unverified. No production fix was made in this verification phase.

## Exact Git state and preservation

Migration worktree: `/home/mk_saadi/projects/persona-projects/llm-electron-e44-migration`; branch `electron-44-migration`; HEAD `576d56957739f446ebe60ae74b57fddf5b6ba04b`, unchanged.

Starting dirty state was modified README.md, package.json and package-lock.json, plus untracked `docs/migration-better-sqlite3-13-experiment.md`, `docs/migration-packaged-electron44-validation.md`, `docs/migration-electron44-regression-results.md` and `docs/migration-electron44-release-build.md`. The full existing diff and SHA256 snapshots were captured before testing. All those files remain byte-identical to their starting state. Original checkout remains clean on `feat/json-web-fetch` at the same HEAD and was only read.

Phase 4C's only new source-tree file is `docs/migration-electron44-release-readiness.md`. All new scripts, installation scratch trees, profiles and raw logs are confined to a fresh ignored `.llm_workspace/phase4c-release-readiness/` directory. No existing report, package or earlier evidence was overwritten. No dependency/version change, production/test source edit, system package installation, host library change, commit, push or merge occurred. The Web Stream workaround is unchanged.

## Artifact identity

These are the existing Phase 4A/B clean-build artifacts, not rebuilt packages. SHA256 was verified again before and after checks:

| Target | Path relative to migration worktree | SHA256 |
|---|---|---|
| AppImage | `.llm_workspace/phase4-linux-release/clean-build/release/Continuum-1.0.0.AppImage` | `2ca161687ffbcdd511825703f1fb0340979a1471363d0a881e0eef6db6dea4fb` |
| Debian amd64 | `.llm_workspace/phase4-linux-release/clean-build/release/continuum_1.0.0_amd64.deb` | `160d7e5e748f15f9a34f24f7722661380a691605afc308b55f491bbe4e7ad32f` |

The freshly privately installed Debian executable reports Electron 44.7.0, Node 24.21.0, ABI 149, Node-API 10 and x64. Its own better-sqlite3 package reports 13.0.3; an in-memory query through it returns SQLite 3.53.4. The AppImage's mounted application and the Debian payload both load the native addon from `resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node`. Archive flags/physical placement and native SHA256 match the already validated clean build.

## Debian metadata, paths and native libraries

Package `continuum` 1.0.0, architecture amd64. Declared Depends:

```text
libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0, libc6 (>= 2.34), libstdc++6 (>= 11)
```

Fresh readelf/ldd inspection confirms the SQLite addon is ELF64 x86-64 and requires GLIBC_2.34, GLIBCXX_3.4.29 and CXXABI_1.3.9. These correspond to the declared libc6 >=2.34 / libstdc++6 >=11 bounds. Electron's executable directly requires at most GLIBC_2.25; its inspected helpers and FFmpeg/Vulkan/SwiftShader have lower glibc floors. The prior all-module inventory also covers ONNX, sharp/libvips and GNU canvas; none exceeds SQLite's selected GNU x64 floor. All selected libraries resolve on the host. Standard C/C++ and desktop libraries are supplied by the OS; symbols alone do not establish distro compatibility.

Desktop entry inspection and `desktop-file-validate` pass. It declares:

```text
Name=Continuum
Exec=/opt/Continuum/continuum %U
Icon=continuum
StartupWMClass=Continuum
Categories=Utility;
```

The executable is present under `/opt/Continuum/continuum` with mode 0755. Six valid PNGs are installed at `/usr/share/icons/hicolor/{16x16,32x32,48x48,64x64,128x128,256x256}/apps/continuum.png`; IHDR dimensions match their directories. These are the current default Electron-branded icon assets, not a new product icon. The .desktop file is readable and valid; it need not be executable in its system applications location.

## Safe actual Debian installation check

**PASS within a private host-library filesystem namespace.** The already-installed bubblewrap 0.11.0 tool and working unprivileged user namespaces were used; no Docker/VM/tool installation was needed.

The host root was bound read-only. Only fresh scratch directories for `/opt`, `/usr/bin`, `/etc`, dpkg state, applications/icons/mime/doc data and logs were writable. Installer UID 0 existed only inside an unprivileged user namespace backed by host UID 1000. PID/network namespaces isolated the process. The target package was read from the existing artifact; no apt dependencies were provisioned.

`dpkg --no-triggers --install <artifact>` unpacked and configured the package and ran its maintainer scripts. `dpkg-query` reported `continuum 1.0.0 install ok installed`. The resulting `/usr/bin/continuum` alternative resolved to `/opt/Continuum/continuum`; the executable/sandbox helper were namespace-root owned and mode 0755, desktop entry validated and all icon paths existed. The postinstall user-namespace probe selected the normal 0755 helper branch.

**Limits:** this used the development host's existing library/package-status snapshot, not Ubuntu 22.04 or Debian 12. System triggers were disabled. Host sysfs/AppArmor access was deliberately not exposed, so the AppArmor profile-installation/kernel-policy branch was not exercised. Installed menu/cache association on a real user desktop was not certified. This is an actual isolated dpkg install, not a claim that all system integration paths were tested.

Final audit confirms the host's `/opt/Continuum`, `/usr/bin/continuum`, `/usr/share/applications/continuum.desktop` and `/etc/apparmor.d/continuum` remain absent. The package was never installed system-wide on the user's machine. Initial scratch setup needed private lock files and an additional private documentation mount; those failed setup attempts are preserved and did not write host installation paths.

## Ordinary X11 launch and sandbox finding

AppImage and Debian payload both **PASS** normal-user startup/restart on the real X11 session (`DISPLAY=:0`, host UID/EUID 1000). Each used a fresh isolated HOME, XDG config/data/cache and TMPDIR. No real application database was opened. Tests launched without `--no-sandbox`, without root and without an artificial root HOME. Main/SQLite/renderer/React root/IPC initialization, writing a message, normal window closure, restart and persistent message recovery pass. Both stages of each target exit 0; no running orphan remains.

However, **ordinary launch is not equivalent to a sandboxed renderer**. `main.js:156` sets `webPreferences.sandbox: false` while retaining contextIsolation true and nodeIntegration false. The same setting is present in HEAD and the shipped ASAR; it predates the migration. Electron documents that this option disables per-renderer sandboxing ([official sandbox documentation](https://www.electronjs.org/docs/latest/tutorial/sandbox)).

The browser's own CDP process inventory identified the actual renderer PID. `/proc` evidence for both packages shows UID 1000, `NoNewPrivs: 0`, `Seccomp: 0`, and no sandbox-disabling CLI flags. Thus **the requested sandboxed-renderer check is blocked by production configuration**, not by root testing or a host inability to create user namespaces. The unprivileged user-namespace probe exits 0 on this host.

Do not silently fix this in Phase 4C. An explicitly authorized sandbox/preload compatibility change and subsequent packaged verification is needed if renderer sandboxing is a release requirement. Phase 3's no-new-regression conclusion remains valid; this finding is a pre-existing architecture/release gap.

Some early diagnostic harness attempts incorrectly parsed process metadata or started before the shared helper was ready. They were corrected only in ignored copies. Emergency cleanup after those failed diagnostics produced GPU/network termination messages; the successful ordinary-launch runs close normally without those fatal lines. These diagnostic errors are not classified as production startup regressions. All raw evidence is retained.

## Essential application checks

| Check | Result |
|---|---|
| AppImage normal-user X11 startup/window lifecycle/persistence | PASS, both exits 0 |
| Debian payload normal-user X11 startup/window lifecycle/persistence | PASS, both exits 0 |
| Fresh installed Debian in-memory native SQLite/runtime probe | PASS |
| nodeHttpFetchCancel.test.cjs under Electron 44 | PASS 5/5 |
| webSearch.test.cjs under Electron 44 | PASS 13/13 |
| Web Stream workaround integrity | Unchanged; no ERR_INVALID_STATE / Controller is already closed in cancellation log |
| Local model launch/readiness/unload | PASS with existing Qwen2.5-VL 3B Q4_K_M and installed llama-server |
| Real generated chat round-trip and SQLite persistence | Transport/generation/persistence PASS; answer-quality result limited, below |
| Cleanup | No task application, server, installer or background process/mount remains |

A recursive scan of the already configured model directory found nine existing GGUF model files; no model was downloaded. The selected existing Qwen2.5-VL 3B model and its existing projector were launched by the packaged app on CPU with two threads, context 8192, f16 caches, and no GPU offload. Installed llama-server version is 0.4.0-dev, build 10899, commit d7680c67b. The server reached ready, real renderer → preload → main chat IPC invoked inference, the assistant response was saved, the server unloaded, and that real response survived an app restart.

**Answer-quality limitation:** the prompt requested RELEASE_OK, but the model generated only `[TASK COMPLETE]` (5 completion tokens). This proves actual inference/round-trip/persistence, not a useful-answer or exact-response pass. The raw transcript and statistics are retained; no model/provider or prompt-processing code was modified to make it pass. Live cloud service was not tested; no credentials were provisioned or imported from the real application database.

An initial test configuration used a quantized q8_0 V cache with flash attention off. The external server rejected it; a bounded direct diagnostic captured `quantized V cache requires flash_attn to be enabled`. Normal f16 cache settings passed. The scanner also emitted its existing GGUF-header DataView warning for this model; native model loading still succeeded. These conditions were recorded rather than fixed or labeled as new Electron migration regressions. No full 118-file suite or broad benchmark was rerun.

## Minimum distributions and Wayland

**Ubuntu 22.04 LTS and Debian 12: NOT RUN.** No local Docker/Podman, libvirt/virsh, QEMU, LXC/Incus, systemd-nspawn, distrobox or proot environment/rootfs was available. /dev/kvm exists, but no ready VM tooling/image was found. Bubblewrap supplied a safe host-library install namespace, not either target OS. No new VM/container runtime or OS was provisioned. Library bounds match the approved support policy, but actual package startup on both minimum distributions remains unverified.

**Wayland: NOT RUN.** The active session is X11. No Wayland display/socket, running compositor, or installed suitable nested Weston/Cage/Sway/labwc/KWin/Wayfire compositor was available. No fake WAYLAND_DISPLAY/environment-only test was attempted, and no compositor or system library was installed.

## Release decision and remaining risks

Recommendation remains **blocked for fully sandboxed-renderer release verification** by the shipped `sandbox: false` setting. Independently, minimum-distribution execution, real installed-desktop integration/triggers/AppArmor handling, Wayland and useful model-answer quality remain outstanding. Package contents, dependency bounds, isolated install, normal-user X11 startup, persistence, native loading, cancellation/web regressions and local engine lifecycle have concrete passing evidence.

Evidence directory: `.llm_workspace/phase4c-release-readiness/`, including protected state/full diff and hashes, artifact manifest, desktop/native/installer metadata, namespace installation command/result/log, ordinary-process/sandbox/PID maps, local model transcript/status/config diagnostic, essential test logs and host/source/process audit. Only this new source-tree report was added. No commit, push, merge, dependency/version change or production fix was made. Stop after Phase 4C.
