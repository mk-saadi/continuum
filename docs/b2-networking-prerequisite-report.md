# B2 networking investigation — blocked before implementation

Date: November 2, 2026 (Asia/Dhaka).

B2 is not implemented. No production code, tool contract, settings, or permission policy was changed. This report records the prerequisite blocker requested in the mission's implementation-safety section. The success condition is unmet.

## Verified environment

The initial working tree was clean. No AGENTS.md was found beneath the parent project directory. No packages were installed, system settings changed, live historical databases edited, or existing user processes terminated.

`bwrap`, `unshare`, and `nsenter` are installed. `slirp4netns`, `pasta`, `passt`, and `rootlesskit` were not found on the host PATH. `/dev/net/tun` exists. package.json supplies no rootless networking helper and does not bundle one for Electron distributions.

The probe `bwrap --unshare-user --unshare-net --ro-bind / / -- /bin/true` failed inside the tool's outer execution restriction with `loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted`. Repeating the probe outside that outer restriction succeeded (exit 0). Therefore host bubblewrap namespace support is available; the first error is not evidence that the host cannot run B2. TAP setup and a networking backend have not been verified.

## Source findings

| Component | Current behavior and integration implication |
| --- | --- |
| src/main/tools/agentTools.js, executeCommand | Builds a fresh bubblewrap user/PID/network namespace per command with `--unshare-net`; background commands use this same executor. No network owner or namespace rendezvous exists. |
| src/main/sandboxFilesystem.js | Starts with an empty filesystem, admits allowlisted runtime trees, mounts only the workspace writable, protects Git metadata, masks internal data, rejects exposed sockets, and strips ambient environment variables. DNS files are admitted only for its separate `network:true` plan. Shell plans require the exact isolated launch prefix; changing argv alone fails validation. |
| src/main/workspaceSandboxProfile.js | Reports trusted main-process facts including netUnshared; checks executable presence, not working namespace creation. |
| src/main/toolApprovalPolicy.js | Autonomous Workspace Write shell execution requires the verified isolated filesystem/network profile. Package operations still require review. Networking must not implicitly grant host execution or bypass this policy. |
| src/main/backgroundCommands.js | B1 owns bounded command records, canonical session/workspace authorization, explicit persistence, revocation polling, normal-completion survival, scoped Stop, and session/shutdown cancellation. Reuse this registry rather than adding another process manager. |
| src/main/foregroundCommand.js | Owns detached process groups, bounded output, finite deadlines, authorization polling, TERM/KILL escalation, and application cleanup. A helper needs explicit resource ownership; assuming it will die with a server is insufficient. |
| src/main/lspExecutionContext.js | Trusted contexts and persistent permission revisions provide revocation checks. A future network-policy change also needs to invalidate live networking and previews. |
| src/main/ipcHandlers.js and src/preload.js | Existing session-scoped background list/Stop path is the appropriate UI integration point. |
| src/components/chat/BackgroundCommandCard.jsx | Existing command card can display verified preview state and Copy URL without a new management panel. |
| src/main/executionCapabilities.js | Currently truthfully advertises sandbox networking unavailable. Keep that claim until a functioning backend exists. |

Native Git has a separate network-enabled sandbox and credential-relay path in agentTools.js. It is not a reusable general-purpose shell networking backend: it has different authorization and launch assumptions. No existing general proxy, shared namespace, or port-forwarding facility was found in the inspected execution paths.

## Backend decision

No backend was selected as production-ready. Plain slirp4netns is insufficient evidence of compliance. Its [upstream manual](https://github.com/rootless-containers/slirp4netns/blob/master/slirp4netns.1.md) documents gateway access to host loopback and the `--disable-host-loopback` mitigation. That flag alone does not establish the mission's broader private-address restriction. A verified egress enforcement layer must cover IPv4/IPv6 special/private destinations, DNS changes, redirects, and host addresses before Development can be enabled.

The smallest candidate to prototype next is an on-demand session + canonical-workspace network owner, a rootless transport with enforced public-only egress, and B1-owned selected-port previews. Share only networking, retaining a freshly verified filesystem plan for every command. Keep the owner only while authorized commands need it; use trusted handles rather than model-supplied PIDs or paths. Validate namespace joining across separately created user namespaces on the actual host before choosing the launch protocol.

An alternative is a public-only HTTP/CONNECT proxy reached through narrowly inherited communication descriptors in each isolated sandbox. It avoids requiring a system rootless transport, but the current repository has no such bridge. Proxy environment variables alone cannot cross the isolated namespace, provide DNS for arbitrary clients, or support server previews. Implementing and claiming that alternative without validating the bridge would not satisfy B2.

Neither option was implemented speculatively. Installing a helper alone would not resolve private-egress enforcement, namespace joining, or preview authentication.

## Required behavior still to implement

- Structured `isolated` / `development` policy in existing settings; missing or legacy values remain Isolated. Development requires explicit activation and backend readiness; failure must be structured and must never select host execution.
- Dependency installation through the contained executor, with workspace-local caches/prefixes and the existing filesystem masks. Keep publication distinct from routine installation when updating approval classification.
- A narrow preview operation taking an owned persistent command ID and selected TCP port. Resolve all other authority from B1; recheck live policy and canonical workspace. No caller-selected PID or workspace authority.
- Random host-loopback port allocation, destination verification in the owning network context, bounded previews/connections, and capability authentication. A localhost listener by itself is not authentication. Support browser navigation, asset URLs, HMR/WebSockets, and hostile local applications explicitly before issuing a URL.
- Store live resources outside serialized background records. Expose only established, verified preview URLs and bounded error state through existing status/events. Never infer success from stdout.
- Release previews and networking references on command exit, expiry, revocation, Stop, session termination/deletion, setup failure, and app shutdown. Restore historical records without reviving authority or URLs.
- Update tool schemas, capability discovery, command descriptions and the existing card only once these behaviors work. Preserve all four modes, Casual Chat restrictions, W7 socket checks, and Full Access routing.

## Verification

Existing regressions were run outside the outer restriction, using their disposable fixtures:

```sh
node --test tests/backgroundCommands.test.cjs tests/backgroundExecution.test.cjs tests/backgroundCommandIpc.test.cjs tests/sandboxFilesystem.test.cjs tests/sandboxGitRelay.test.cjs tests/permissionPolicy.test.cjs tests/permissionIsolationReliability.test.cjs tests/sandboxRuntimeSettings.test.cjs tests/w7SandboxSockets.test.cjs tests/casualToolAuthorization.test.cjs tests/w7CasualRecovery.test.cjs
```

Result: **81 passed, 0 failed, 0 skipped**. The B1 real HTTP reproduction reported 200 before completion, 200 after normal completion, and unreachable after Stop. This validates existing B1 behavior, not B2 networking. The first restricted test attempt failed suites requiring socket creation; direct W7 output identified `listen EPERM`. The successful host run supersedes that environmental failure. Temporary detailed host-run output: `/tmp/continuum-b2-regressions.log`.

`npm run build`: passed (Vite 6.4.3, 1843 modules); existing large-chunk warning. No packaged Electron build or UI verification was performed.

B2 outbound HTTPS, DNS, npm/pnpm/Yarn/pip installation, private-address filtering, managed preview, cross-command reachability and cleanup acceptance are **not run / not implemented**. No Vite dependency-install/preview workflow is claimed. The 81 existing tests do not establish any new network security guarantee.

Only this report was added. Application behavior remains unchanged and offline Workspace Write has not been broadened. Resume implementation on a supported Linux environment with an explicitly provisioned candidate backend (or validate the descriptor-proxy alternative), then complete egress enforcement and the full requested acceptance matrix before declaring B2 ready. Non-Linux support, bundled helper provenance/licensing/architecture, AppImage/deb runtime dependency strategy, and packaged-app lifecycle remain unresolved.
