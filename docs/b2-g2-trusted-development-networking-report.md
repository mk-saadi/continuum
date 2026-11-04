# B2-G.2 — Explicit Trusted Development networking

November 3, 2026 · Asia/Dhaka.

**Source-tree development workflow verified; production activation remains unavailable.** Trusted Development is a deliberately broader network trust contract. The B2-G.1 host-address weakness has not been repaired. Its report and counterexample remain historical evidence.

## Initial working tree and scope

Before editing, inspected git status and all eight requested reports, their evidence JSON, owner/worker, execution service, filesystem planner, configuration, IPC and existing fixtures. No applicable project AGENTS.md was found (only dependency copies). Initial status contained 16 modified tracked files and substantial untracked B2 implementation, reports and tests, plus chart work. The exact initial status is preserved in `b2-g2-trusted-development-networking-evidence.json`. Existing work was retained. No commit, push, reset, stash, clean, live conversation database change, global package install, host firewall/sysctl change, unrelated MCP launch or unrelated process termination was performed.

## Contract, migration and authorization

The policy is now `{version:2, policy:"isolated"|"trusted_development"}`. Missing, invalid and legacy v1 Development values normalize to Isolated. No existing workspace automatically acquires networking. This is one application-wide Workspace Write preference, explicitly disclosed as applying to all sessions; it does not add a permission mode.

Trusted Development permits general outbound IPv4, including potentially reachable host-local, LAN, VPN and local infrastructure. Commands and dependency lifecycle scripts can cause network-side effects; filesystem containment does not prevent them. Credentials actually available to a command can authenticate network requests. Ambient host credentials remain stripped by the filesystem environment allowlist. External IPv6 remains rejected. Guest-local IPv4/IPv6 communication remains available. Slirp's existing `--disable-host-loopback`, mount sandbox and seccomp remain enabled, so this is not described as unrestricted connectivity to every destination.

The production worker explicitly constructs the trusted policy. Its owner-local nft rules permit IPv4 without the old private/special/host4 exclusions and retain external IPv6 rejection. The old public-only owner default exists solely for historical experimental fixtures and G.1 reproduction; production does not select it. Existing address-policy integrity/expiration checks and host-network-change monitoring remain conservative prerequisites. Monitoring may stop operations when interfaces/routes change; it is not an atomic host-isolation guarantee.

The focused control sits alongside existing engine/directory settings. It shows Isolated and a visibly disabled Trusted Development choice with release blockers. A future qualified activation requires the main-process native warning dialog, with Isolated as default/cancel. Renderer-supplied booleans cannot acknowledge it. Generic `saveConfig` cannot set network trust. Persistence requires an Electron safeStorage-protected decision receipt; unprotected manually edited choices fail closed. Linux `basic_text` storage cannot enable it. Receipt data is not returned by `getConfig`. As with other local app settings, OS-user compromise is outside this boundary; the receipt is not an anti-rollback mechanism against a host actor holding historical protected settings.

Reverting saves Isolated and awaits owner invalidation. Live owner checks also observe policy changes. A later Isolated choice invalidates a pending confirmation, preventing an old dialog from reenabling trust. Existing mode/revision/session/B1 authorization remains authoritative. Full Access uses its existing host executor. Read Only, Ask for Approval, Casual Chat and native command/package approvals retain their previous rules. There is no Full Access fallback or production environment-variable override.

## Files changed for G.2

- `workspaceNetworkPolicy.js`: v2 normalization, strict settings validation, precise disclosure and release readiness blockers.
- `configStore.js`: protected decision persistence, native opt-in, stale-confirmation guard and awaited revocation.
- `ipcHandlers.js`, `preload.js`: narrow status/set APIs under existing trusted-main-frame IPC checks.
- `WorkspaceNetworkSettings.jsx`, `main-app/MemorySettings.jsx`: focused control in the existing settings UI.
- `experimental/network_owner.py`, `networkExecutionWorker.py`: explicit trusted IPv4 policy; retain namespace ownership, helper hardening, external IPv6 rejection and resource gates.
- `networkExecution.js`, `tools/agentTools.js`: select only the new policy name; preserve trusted launch and execution authorization.
- `sandboxFilesystem.js`: fixed isolated npm, pip and XDG cache locations.
- `executionCapabilities.js`: correct release-blocked Trusted Development preview terminology.
- `b2dNetworkExecution.test.cjs`, `b2fPreviews.test.cjs`: protected disposable trust fixtures, controlled private-host acceptance and real registry installation before Vite.
- `sandboxFilesystem.test.cjs`: updated cache environment allowlist assertion, retaining secret/injection stripping checks.
- `helpers/networkSafeStorage.cjs`, `b2g2Trust.test.cjs`, `b2g2Settings.ui.cjs`, `b2g2Packaged.test.cjs`: explicit test-only storage fixture, consent/security tests, Electron UI and packaged archive checks.
- This report and G.2 evidence JSON.

Paths above are under `src/main`, `src/components`, or `tests` as appropriate. Unrelated initial modifications are not attributed to G.2.

## Package-manager compatibility and actual results

The authoritative planner still supplies private writable HOME and scratch, read-only system/certificate trees, managed resolver, masks, Git metadata protection and socket checks. New cache variables are fixed to `/tmp/continuum-cache/{npm,pip}` and `/tmp/continuum-cache` inside each command's private scratch; host HOME/application data are not admitted. pnpm and Yarn fixtures use explicit private store/cache paths. Caches are ephemeral across commands; installed workspace files and lockfiles persist.

The actual approved native Workspace Write dispatcher installed Vite 6.4.3 using `npm install --no-audit --no-fund`, then installed `is-number@7.0.0` using `npm install <package>`. Both downloaded real dependencies; the fixture asserts installed Vite and a generated package-lock. Dependencies were not copied from the repository. Normal lifecycle scripts were enabled. Separate sandboxed workflows passed pnpm install and `python3 -m pip install --target ./pip-fixture six==1.17.0`. Pip's namespace-root warning was observed; its target remained workspace-local. Yarn was absent from the sandbox and was not run. An actual shallow remote Git fetch from the public octocat/Hello-World repository into guest-private `/tmp/git-fetch-fixture` passed through the trusted shell dispatcher. Existing contained Git fetch/push relay regression also passed; the dedicated `git_sync` tool was not changed.

A controlled ephemeral service bound to this host's private IPv4 returned `OK` through the actual trusted dispatcher, verifying the disclosed host/private behavior without probing real administrative services. DNS/public HTTPS passed. External IPv6 and guest nft mutation attempts failed. Historical public-only fixture tests still exercise their own restrictive contract, not the new production policy.

## Vite, browser, preview and B1

After installation, standard Node launched Vite through the same dispatcher as a persistent B1 command. The real isolated namespace server was reached through the existing authenticated pipe gateway and Chrome. Assets, JavaScript, CSS, client routing, reload and HMR were verified. The command and preview survived successful response completion, supported later-run access and closed on Stop. Cross-session/project access, forged contexts, wrong port/sibling ownership, credential-free HTTP/WebSocket access and stale capabilities remain denied. No slirp host forward or LAN listener was introduced.

The seven real preview groups also cover mode/rule/session revocation, expiry, owner failure, aggregate cgroup OOM, resource scope checks, owner SIGKILL and abrupt application-parent SIGKILL cleanup. The measured isolated Vite scope snapshot was 68,599,808 bytes current / 72,601,600 bytes peak at inspection; it is not a whole-run or installed-application memory claim.

## Verification results

Final, separate suites (counts overlap where explicitly rerun):

| Verification | Pass | Fail | Skip |
| --- | ---: | ---: | ---: |
| Node regression selection: B1, gateway/browser, preview IPC, resources, W7/filesystem, permissions, Casual Chat, initial four trust groups | 93 | 0 | 0 |
| Final B2-D real dispatcher and lifecycle | 5 | 0 | 0 |
| Real installed Vite/Chrome/HMR, B1, OOM/crash preview groups | 7 | 0 | 0 |
| Final expanded trust/confirmation/storage suite | 6 | 0 | 0 |
| B2-C historical public-only real owner groups | 5 | 0 | 0 |
| B2-E deterministic policy groups, including expiry | 4 | 0 | 0 |
| B2-F resource prerequisite groups | 2 | 0 | 0 |
| Electron networking settings fixture | 1 | 0 | 0 |
| Existing Background Commands/preview Electron fixture | 1 | 0 | 0 |

Yarn workflow: one unavailable optional workflow, not a passing test. Production Vite build passed with existing large-chunk warnings. JavaScript syntax, Python AST, address-policy JSON and `git diff --check` passed. Explicit resource tests retain missing helper, manifest tampering, wrong architecture, executable permission, expired policy and failed cgroup gates. Source-tree test factories use explicit injected dependencies/readiness and test-only storage. None is imported by production. Full logs are under `/tmp/continuum-b2g2`; summarized durable evidence is in the adjacent JSON.

Intermediate failures are not counted as successes: the restricted initial socket test hit EPERM; the first broader run had 91 passes/1 failure/1 skip because its environment assertion omitted the new cache variables and its separate browser fixture was disabled. Corrected final run is 93/93. The first combined real run had 11 passes/1 cancellation because the newly reachable sentinel did not drain the request socket; the sentinel was corrected and final dispatcher/preview reruns passed separately. The first restricted package build failed GitHub DNS resolution. An intermediate package archive built while source was edited failed integrity/source comparison; only frozen-source rebuilt artifacts qualify for subsequent inspection.

## Release readiness and exact remaining blockers

**Trusted Development is not selectable in production.** Readiness intentionally remains false even if a manifest appears. It now reports package/runtime release blockers rather than claiming atomic host-address exclusion is required by this revised contract. The unchanged dependency resolver still requires packaged Linux x64, trusted absolute resources, all file hashes, helper ELF architecture/executable permissions and absolute system utilities. The worker additionally verifies effective systemd/cgroup limits before starting an owner. No temporary helper becomes a production dependency.

No complete networking resource bundle, helper license/source bundle or new supported platform matrix was added. The current Electron Builder file rules package JavaScript but do not supply the Python/policy/helper resource tree. Required next release work:

1. Assemble `workspace-network/manifest.json`, worker, preview bridge, experimental owner, address policy and pinned x64 slirp4netns outside asar; verify every hash and executable bit. Keep the owner's independently pinned helper identity check.
2. Include slirp4netns and bundled library licenses, notices and compliant corresponding-source/source-offer materials; establish provenance, security update ownership and reviewed build inputs. The approved temporary helper is fixture-only.
3. Qualify absolute Python, bubblewrap, util-linux, nftables, iproute2 and systemd-run versions and runtime libraries. Declare/check package prerequisites without sudo at normal startup.
4. Verify user namespaces, TAP, seccomp, netlink, namespace-local nft and effective cgroup-v2 memory/swap/tasks/CPU/group-OOM controls on each supported distro/kernel and both package formats.
5. Run installed AppImage/deb native confirmation plus protected settings, actual package install, browser/HMR, W7, revocation, crash and shutdown acceptance with the complete resource bundle. Archive checks alone are insufficient.
6. Review retained address-policy maintenance/expiration and host-network-change availability behavior under the trusted contract. Add separately qualified architecture bundles before enabling any non-x64 platform.
7. Replace the explicit closed release gate only after these artifacts and acceptance evidence are reviewed. Never use a preference, model request, fixture environment variable or arbitrary manifest field to waive it.

Linux x86-64 on this development host is the only source-tree environment exercised. No Linux distribution is newly declared production-supported for Trusted Development. Windows, macOS, ARM64, external IPv6, unrestricted host loopback, persistent cross-command caches and arbitrary project-specific HMR overrides are unqualified/unsupported. The existing authenticated preview restrictions, including disabled service workers, remain.

## Package artifact outcome

Frozen-source AppImage and deb builds completed using Electron Builder. Outputs are `release/Continuum-1.0.0.AppImage` and `release/continuum_1.0.0_amd64.deb`; SHA256 and sizes are recorded in the evidence JSON. The AppImage was extracted without installation; its actual embedded archive passed integrity/source comparisons and fail-closed readiness. The deb was also extracted without installation and its embedded archive passed the same check. Staging, AppImage and deb archive checks each passed 1/1, with zero failures/skips. Intermediate invalid build outputs were replaced with the frozen rebuilds (including staging app.asar and generated updater metadata). These packages are development artifacts, not qualified Trusted Development releases. No deb was installed and no live application profile was launched. Bundle licensing, system dependencies, native settings/key-store behavior and installed-package network/lifecycle acceptance remain release blockers.
