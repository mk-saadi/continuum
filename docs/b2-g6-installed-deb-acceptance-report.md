# B2-G.6 — installed deb engineering acceptance complete

November 4, 2026 · Asia/Dhaka.

**The actual installed-deb technical gap is closed for the exact disposable Linux target below. Production Trusted Development remains disabled.** Redistribution/source-delivery approval and accepted security maintenance ownership remain outstanding. The enabled artifact is visibly NONRELEASE and confers no production entitlement.

## Repository preservation and scope

Read the five required handoffs first, then inspected the builder, NONRELEASE staging/assembly, resource resolver, readiness, native consent, Background Commands integration and installed-runtime fixtures. No applicable repository AGENTS.md was found. Initial working tree: **27 modified tracked files and 75 untracked status entries**. Exact status is embedded in the adjacent evidence; initial file hashes remain at `/tmp/continuum-b2g6/initial-sha256.json`.

No shipping application source or normal build configuration changed. The G.5 worker cwd `/` fix is preserved. Added an offline installed-deb qualification derivation and five focused test fixtures; updated this report/evidence and the release checklist. Existing tracked/untracked implementation and unrelated UI work were retained. Earlier G.4/G.5 outputs and intermediate G.6 artifacts remain intact. Pre-acceptance G.6 documents were archived under `/tmp/continuum-b2g6/accepted-evidence` before replacement.

No commit, push, stash, reset, clean, primary Continuum install/profile/database edit, host firewall/sysctl/kernel change, unrelated process kill or unrelated MCP launch occurred. The requested production build refreshed ignored generated output. All guest/profile/project/package material is disposable.

## Provisioning and qualified target

Initial discovery found host KVM/TAP but no virtualization executable or accessible guest image. The user explicitly authorized system-wide QEMU installation and necessary dependencies. A fresh apt simulation showed **15 new packages, 0 upgrades, 0 removals**. Noninteractive sudo required authentication; the user completed the exact approved transaction locally. Host apt history confirms only those 15 new packages, with no unrelated replacement/removal. Installed QEMU/qemu-utils: `1:8.2.2+ds-0ubuntu1.18`. No further privileged host operation was needed.

Downloaded the official Ubuntu noble cloud image over HTTPS, verified SHA-256 `04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94` against the official HTTPS checksum listing, and booted a fresh 32 GiB qcow2 overlay with KVM, four virtual CPUs and 6144 MiB RAM. No image-signature verification is claimed. QEMU used user-mode networking and only a loopback SSH forward, `127.0.0.1:22266`. No host TAP, bridge or firewall setup was introduced. ISO creation used pycdlib in an isolated `/tmp` Python environment.

The qualified **test configuration**, not a blanket Ubuntu support declaration:

| Item | Actual guest |
| --- | --- |
| OS / architecture | Ubuntu 24.04.5 LTS, amd64 |
| Kernel | `6.8.0-147-generic` |
| User session | tester UID 1000; real SSH/PAM session; systemd user manager running; linger enabled |
| Cgroups | Unified v2; cpu, memory and pids controllers available to user manager; effective limits verified below |
| Display / secrets | Xvfb :99, Openbox, real GNOME Keyring Secret Service; GNOME desktop/session selection for Chromium encrypted storage |
| Python | `3.12.3-0ubuntu2.1` |
| Bubblewrap | Pop!_OS noble `0.11.0-2~1750183577~24.04~313c27a` |
| util-linux | `2.39.3-9ubuntu6.6` |
| nftables / iproute2 | `1.0.9-1ubuntu0.1` / `6.1.0-1ubuntu6.4` |
| systemd / libpam-systemd | `255.4-1ubuntu8.18` |
| Development tools | System Node 18.19.1, npm 9.2.0; downloaded Vite 6.4.3 and is-number 7.0.0 |
| Browser | Google Chrome `157.0.8103.38-1`, sandbox enabled |

Stock Ubuntu noble bubblewrap 0.9.0 fails the existing floor. The exact compatible Pop!_OS package was downloaded through apt metadata and installed **inside the guest**; no floor was lowered. Ubuntu's initial AppArmor policy denied unprivileged user namespaces. The disposable guest alone sets `kernel.apparmor_restrict_unprivileged_userns=0` in `/etc/sysctl.d/99-b2g6-disposable-guest.conf`. Host settings are unchanged. Namespaces, guest TAP, nftables and systemd resource scopes subsequently worked. Qualification applies to this explicit combination, including its namespace policy and secret-service session.

## Package identity, installation and integrity

| NONRELEASE artifact | SHA-256 |
| --- | --- |
| Fixed G.5 closed-gate deb, version 1.0.0 amd64 | `5780b4081baa528c587d9d0d0f64d43399cca4b38d5c74c319cb310bb010af65` |
| Accepted G.6 enabled qualification deb | `375abebec1f902879eba1308f284c86335f22b9bab3d52c31e579195faea88f8` |
| Accepted qualification app.asar | `e04a63401fdde308e628e4a1f2b70e618387bb869311abe896dcf9bcb7ea0001` |
| Helper | `dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980` |
| Review archive | `676fcef46f406b7511c64f638114a45dd9f38951899e3461e0d7e2c53e0e5225` |

Normal deb: `/tmp/continuum-b2g5/fixed-packages/Continuum-B2G5-NONRELEASE-1.0.0-amd64.deb`. Accepted qualification: `/tmp/continuum-b2g6/deb-qualification-accepted/Continuum-B2G6-NONRELEASE-QUALIFICATION-amd64.deb`. Rehash before reuse; temporary storage is not durable release storage.

The actual deb control metadata declares Python >=3.11, util-linux >=2.39.3, bubblewrap >=0.11.0, nftables >=1.0.9, iproute2 >=6.1.0, systemd/libpam-systemd >=255, plus existing Electron GUI dependencies. All seven fixed-path executable probes pass in the guest. The provisioned repositories/packages satisfy these floors. Guest `ldd` reports no missing Electron runtime libraries. No required utility omission or genuine package metadata defect was established.

Apt actually installed the normal deb; dpkg reported `install ok installed`. The combined Continuum/Chrome/X11 installation removed no packages. The derived deb has the same package version, so an explicit local **reinstall** was required; its actual installed receipt, ASAR and deb hashes were verified afterward. No unrelated guest packages were removed during that replacement.

Actual resources resolve under `/opt/Continuum/resources/workspace-network`, outside ASAR. All six manifest payload/material entries match actual installed bytes; helper and review pins match independently. Helper mode is root:root 0755. Package directories are normally root:root 0775 and ASAR/receipt 0664; only root/root-group can write them. Qualification checks physical ownership/modes using `original-fs`, avoiding Electron's virtual ASAR metadata. The receipt matches the actual installed archive hash.

## Normal installed GUI and bounded enabled qualification

The installed normal deb passed **two launches** through `/opt/Continuum/continuum`, with actual packaged main/preload/renderer/native IPC, `app.isPackaged === true`, working Settings, Isolated default, rejected native activation and clean shutdown. Playwright explicitly enabled Chromium sandboxing; no `--no-sandbox` argument was used. Normal ASAR contains neither G.5 nor G.6 qualification modules.

`scripts/qualify-installed-deb.cjs` derives a separate fresh temporary package from only the pinned fixed deb, verifies current selected source and complete helper/material integrity, and binds qualification to one different disposable guest machine ID, fixed installed resource path, private profile/home, exact archive receipt/helper/review hashes and a 24-hour deadline. It requires actual dpkg installed status and root-controlled installed files. It preserves native consent, safeStorage, guardTool/command approvals, session authority, sandbox and cgroup enforcement. No shipping gate, environment readiness override or renderer permission switch was added. `productionQualified` remains false.

Only `main.js` labeling/banner, the copied policy export and generated `src/main/b2g6Qualification.js` differ in the qualification ASAR. The generated module exists only in temporary package output, not repository application source or normal builds. A real wrong-profile launch rejected activation; deterministic expiry and unsafe derivation boundaries also pass. Screenshots show the visible NONRELEASE banner. The adapted fixtures retain G.5 project/example text; their runtime paths, artifact hashes and evidence are actual installed G.6 runs.

## Installed native consent and development workflow

From a fresh disposable profile, Isolated was selected. The actual PID-matched native warning was cancelled, leaving Isolated; reopening and accepting it enabled Trusted Development. Electron reported `gnome_libsecret` and encryption available, wrote its own protected receipt and restored the choice after restart. No dialog result, receipt, permission mode or safeStorage implementation was injected.

The trusted harness invokes the **installed** guardTool and native dispatcher with explicit command approvals; this is not an LLM-driven conversation or autonomous approval-UI claim. Full Access was never selected. Real DNS/HTTPS certificate validation passed. Real npm downloaded Vite and is-number, produced package-lock/node_modules and executed a sandboxed postinstall assertion: guest-host HOME sentinel inaccessible, sandbox HOME `/sandbox-home`, npm cache `/tmp/continuum-cache/npm`, and project-local writes present. No copied preinstalled dependencies supplied acceptance.

Standard Vite ran with `survive_run_completion: true`. It survived normal run completion and remained reachable through a later authorized run. Actual kernel values were memory.max `1073741824`, memory.swap.max `0`, pids.max `128`, cpu.max `200000 100000`, memory.oom.group `1`. A bind-only negative probe confirmed no raw host-side guest port 5173 listener while sandbox Vite served that port.

Actual Background Commands **Create Preview**, **Open Preview** and **Stop** buttons passed. Native shell/browser handoff reached a separate real Chrome profile. JavaScript, CSS, client route/reload, same-origin WebSocket connection and source-edit HMR passed. Credential-free HTTP remained 403. Stop closed both unauthenticated requests and previously authenticated Chrome access, stopped the server and emptied network-owner state. Returning to Isolated passed.

Installed smoke negatives also verified denied nft mutation, denied external IPv6 request and absence of inherited namespace handles. Trusted Development still permits reachable host-local/private/LAN/VPN IPv4; no public-only guarantee is claimed.

## Lifecycle, cleanup and reused coverage

Installed deb passed **5/5** selected lifecycle/fault cases: permission-mode revocation, session deletion, worker SIGKILL, live switch to Isolated, and active application shutdown/restart. Every fault started with a live disposable server and preview, inspected the actual packaged worker's resource scope, closed preview access, emptied both registries, verified captured scope PIDs exited and verified the scope directory disappeared. Restart preserved the encrypted choice but revived no server/preview authority; old preview access was rejected. Final policy returned to Isolated.

Final independent inspection found no live installed app/worker/owner/helper processes, confirmed the workflow scope plus all five fault scopes absent, and confirmed the old preview closed. The guest then shut down gracefully. QEMU is no longer live, its pidfile was removed and the host SSH-forward listener is gone. The disposable disk/evidence remain under `/tmp` for review.

G.5 AppImage evidence supplies the unchanged backend's full ten-case history. Finite expiry, session termination, helper failure, owner failure and controlled OOM were **not rerun under deb**. G.5 source-tree W7/B1/B2 security regressions were retained without a broad repeat because no shipping implementation changed and no package-specific backend regression appeared. None of that reused coverage is labeled installed-deb coverage.

## Final checks and limitations

- New qualification unit suite: **2 passed, 0 failed, 0 skipped/cancelled**.
- Installed GUI/harness scripts: **4 passed, 0 failed, 0 skipped**: closed GUI, wrong-profile boundary, full workflow, lifecycle. The two normal launches and five lifecycle cases are nested checks, not extra unit-test totals.
- Earlier preparatory packaging suite: **12 passed, 0 failed, 0 skipped**; separate from the final new tests.
- Final production Vite build passed; existing large-chunk warning remains.
- JavaScript syntax: **6/6** new repository files, plus the generated module. Python AST syntax: **4/4** workers/native helper. JSON parsing: **5/5** distinct files. `git diff --check` and new-file trailing-whitespace checks pass.

Five earlier setup/harness attempts failed and are retained separately: apt skipped same-version installation; virtual ASAR ownership metadata; generic desktop selected basic_text; harness Node PATH parent overlapped app data and was correctly denied; lifecycle fixture tried a duplicate project root. Corrections were confined to derivation/test setup. Those attempts are not counted as acceptance and establish no shipping backend defect. Final successful workflow/lifecycle use the same accepted qualification deb.

Evidence, screenshots and logs: `/tmp/continuum-b2g6/accepted-evidence` and `/tmp/continuum-b2g6/authorized-provisioning`. Full machine identity, package inventories, hashes, scope/PID results, raw UI results, exact fixture sources and validation are referenced or embedded in the adjacent JSON. Guest artifacts and qualification expire; no ongoing production entitlement follows from this report.

## Release decision

**Engineering qualification complete for the exact installed NONRELEASE target above; production release authorization pending.** The source readiness function still returns unavailable. No production activation was implemented.

Remaining blockers are responsible approval of exact helper/source/notices/relink materials and delivery channel, and explicit accepted security maintenance ownership. Review must include the G.4 pinned archive plus the G.5 recipient relink addendum; neither technical hash verification nor successful relinking constitutes approval. No approver or owner is appointed by package metadata or this engineering report. Ownership must cover helper/embedded-library advisories, address-policy data, triage/response, rebuild/repin/manifest updates and packaged requalification. Address-policy review remains due December 3, 2026 UTC.

The updated release checklist records technical acceptance while leaving every human approval and production-activation field pending.
