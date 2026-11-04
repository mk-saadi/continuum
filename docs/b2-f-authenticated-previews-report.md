# B2-F — authenticated preview infrastructure, partial acceptance

November 3, 2026, Asia/Dhaka.

**Development remains disabled. B2-F is not fully accepted.** Authenticated pipe-only previews work with real isolated B1 servers and an external browser. Vite HTTP/assets/HMR work through the gateway with a separately controlled host transport. Full isolated Vite acceptance is blocked by the existing 512 MiB virtual-address-space limit. These are distinct results; the host Vite fixture is not an execution fallback.

## Initial repository and architecture

Inspected git status before editing. Seven tracked files were already modified: main.js, backgroundCommands.js, configStore.js, foregroundCommand.js, lspExecutionContext.js, sandboxFilesystem.js and tools/agentTools.js. B2-A through E reports/evidence, experimental owner, network execution/policy/dependency modules and B2-C/D/E tests were already untracked. All were retained. No reset/stash/clean/commit/push, live database edits, system installs, host firewall/kernel changes, unrelated MCP startup or user-server termination occurred.

Read the prerequisite and B2-A/C/D/E reports and inspected their evidence and real tests. Reused B2-D's owner registry, pinned descriptors, private Python worker, immutable launch permits and verified filesystem plans. B1 remains the sole process/lifetime registry. W7 containment, existing policy modes, Casual Chat and Full Access paths remain intact. The B2-E readiness function is unchanged.

## Files changed for this stage

- `src/main/developmentPreviews.js` (new): trusted gateway factory and gated singleton; browser handoff, HTTP/WebSocket proxying, readiness, limits and teardown.
- `src/main/networkPreviewBridge.py` (new): fixed-code pipe connector inside the existing owner namespace; connected-socket ownership verification.
- `src/main/networkExecutionWorker.py`: bounded private bridge protocol, credit acknowledgments and connector cleanup alongside existing command execution.
- `src/main/networkExecution.js`: pipe-backed Duplex streams and private per-operation preview capabilities. No new owner registry.
- `src/main/backgroundCommands.js`: WeakMap-backed capabilities attached to real B1 records; trusted command/session/workspace/revision/lifetime validation. Capabilities never enter public records or durable history.
- `src/main/networkDependencies.js`, `tests/b2eDependencies.test.cjs`: the new trusted connector must also be present and manifest-verified in any future complete resource set.
- `src/main/executionCapabilities.js`: explicitly reports Development previews unavailable.
- `main.js`: includes the gated preview singleton in application shutdown.
- `tests/b2fGateway.test.cjs`, `tests/b2fPreviews.test.cjs`, `tests/b2fViteBrowser.test.cjs`, `tests/helpers/previewWebSocket.cjs` (new): controlled gateway, real namespace/B1/browser, optional isolated Vite and browser/HMR acceptance.
- This report and `b2-f-authenticated-previews-evidence.json`.

Existing changes in the other seven tracked files were preserved, not recreated as B2-F work.

## Transport and authority

The gateway owns one selected host-loopback HTTP listener per preview. It creates no slirp forward, host-side upstream TCP listener or Unix socket. The upstream is a multiplexed, credit-controlled stream over the existing inherited main/worker pipes. The worker joins its pinned owning-user/network namespace and runs only the fixed trusted connector. Guest destination is always literal 127.0.0.1 plus the selected integer TCP port; neither callers nor HTTP paths select another destination. This supports guest 127.0.0.1 and guest 0.0.0.0 listeners, without host/LAN wildcard binding.

The connector drops inherited namespace descriptors before connecting. It checks the established server-side socket's full loopback address/port tuple and inode against descriptors held by the actual command process tree. A live sibling command cannot authorize another command's listening port. A command exiting or a different command rebinding that port cannot inherit authority. This is stronger than checking a stdout announcement or merely finding a listening port. If procfs visibility/ownership verification fails, the connector fails closed; no forwarding fallback is used.

The namespace/PID inputs used internally come from the worker's live Popen records and pinned owner, never caller input. Guest code and renderer processes receive no handles, PIDs or bridge-control endpoints. Connector creation is synchronized against owner closure. It uses the same namespace-local OUTPUT policy, with a fixed guest-loopback destination.

B1's private capability resolver requires a trusted main Workspace Write context, current project/canonical workspace, matching persistent permission revision, an active persistent record, unexpired command lifetime, live network operation and current authorization. Guessed IDs, cloned contexts, cross-session and cross-project contexts fail. No historical record restores a capability after restart. Previews do not take an independent indefinite owner lease; their streams are subordinate to the live command.

## Authentication and browser design

Random ports are not authentication. The default singleton refuses creation at the unchanged readiness gate. Internally, `open(context, commandId)` creates a 256-bit, 15-second, single-use handoff bound to that preview and invokes the trusted external-browser callback. The credential appears only in a URL fragment during the handoff; it is not returned by create/status, stored in B1 records, sent as a model argument or logged. The browser bootstrap removes the fragment with replaceState before POSTing it to the gateway. A successful POST consumes it and sets a fresh HttpOnly, SameSite=Strict, host-only browser cookie with finite lifetime capped by the command. Replay and expired/invalid credentials fail. A subsequent Open replaces any unused handoff.

Both HTTP and WebSocket requests require the cookie. The gateway strips only its own cookie before forwarding; application cookies and Authorization headers remain supported. Wrong Host, foreign Origin, cross-site Fetch Metadata, service-worker requests and credential-free WebSocket upgrades are rejected. WebSockets require an exact Origin match. No permissive upstream CORS policy is forwarded. Authentication is distinct from Origin checks: a local HTTP client spoofing Origin still lacks the credential.

Each preview gets a fresh random 127/8 loopback address and OS-assigned ephemeral port, providing a fresh browser origin and avoiding ordinary storage reuse. The listener accepts only that exact numeric Host and port. The kernel chooses the free host port; callers cannot request bind addresses or collide with a selected user port. The combination is still authenticated with a cookie.

HTTP loopback does not provide TLS/Secure-cookie transport guarantees; no claim of such guarantees is made. SameSite/HttpOnly, exact origin validation and listener scope are enforced. As with ordinary browser credentials, this protects against unauthenticated local clients, not OS-user compromise, browser-profile theft or process debugging. The handoff is briefly visible to the browser/OS URL launch mechanism; it is intentionally short-lived and single-use. Service workers and frames are disabled by the gateway CSP; applications requiring workers need separate compatibility work. This prevents a preview application from persisting a service worker across authority changes.

## HTTP, WebSockets and readiness

HTTP supports GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS, queries, status codes, application headers, cookies, static modules/CSS and client-side routes. Requests and responses stream with backpressure. Hop-by-hop headers are removed/reframed, forwarded-header spoofing is removed, Host is set to the selected guest server, and the authenticated browser Origin is preserved. Same-server absolute localhost redirects are rewritten to the preview origin. Malformed upstream HTTP produces 502; protocol failures never select host execution.

WebSocket upgrades are authenticated before opening an upstream. Upgrade response and head bytes are forwarded, then traffic streams bidirectionally within the same listener and authority. No HMR secondary port is exposed. Default Vite same-origin HMR was verified in Chrome against the controlled host transport, including a real source edit, update frame and changed DOM. Hardcoded HMR host/clientPort/protocol settings pointing elsewhere are unsupported: remove those overrides so Vite uses the managed browser origin. Application CSP that blocks the preview origin may require project-specific configuration; the gateway does not broadly relax it.

Creation probes actual HTTP through the authenticated gateway with a private temporary cookie, discards that cookie, and returns a credential-free URL only after a 2xx/3xx root response and fresh authorization check. It does not trust stdout. Starting a not-yet-listening server fails creation; the trusted caller can retry within its own bounded startup workflow. Copying the base URL is useful only in an already authorized browser profile. A new profile requires the trusted Open handoff.

## B1 lifecycle and limits

Normal successful run completion preserves both server and preview for persistent commands. Later trusted contexts can inspect the same preview. Stop/controller abort closes access immediately; authorization polling covers policy revisions, process/owner loss and session lifecycle. Expiry, mode/rule revocation, termination/deletion and owner shutdown were tested with real B1 commands. Gateway error/shutdown destroys all client/upstream sockets, clears grants/cookies/records and stops monitoring. No separate process manager or restored preview authority exists.

Limits: four previews application-wide per service, one per command; 32 browser connections and 32 upstream/pending connections per preview, plus 32 bridge streams per network worker; 16 KiB HTTP headers; 10-second header timeout; 120-second HTTP request and socket idle limits; 32 MiB request bodies; 5-second endpoint/connect readiness; 128-byte bootstrap body; 60 bootstrap POST attempts per preview lifetime; four browser credentials; 15-second handoff and at most 30-minute browser session. WebSocket absolute lifetime cannot exceed the finite B1 command lease. Each stream direction has at most one unacknowledged 16 KiB protocol chunk with bounded kernel pipes/Node backpressure. Connector processes retain existing CPU/fd/address-space limits.

The gateway does not constrain a browser application's independent OS network activity; it constrains its own fixed guest upstream route. It is not a browser sandbox or public tunnel.

## Actual verification

Final combined Node run: **137 passed, 0 failed, 1 explicitly skipped** (138 total). The skipped test is `real B1 dispatcher preview: pipe-only upstream, browser authentication, HTTP, Vite HMR and cleanup`, enabled only with B2F_VITE=1 plus the explicit helper. It remains unaccepted because real Vite startup fails under the current owner resource limit. This skip is not a passing Vite acceptance result.

Real isolated tests verified: Python server via normal native dispatcher/B1; guest loopback and wildcard binding; actual authenticated gateway HTTP; external Chrome loading a guest marker through the pipe bridge; command-port ownership; cross-project rejection; port reassignment; successful completion survival; later-context inspection; Stop; lifetime; mode/rule revocation; session termination/deletion; owner invalidation/shutdown; closed listeners and no retained owner references.

Controlled gateway tests verified: unauthenticated denial; invalid/multibyte/expired/replayed handoffs; cookie expiry; Host/Origin/cross-site/service-worker denial; unauthorized and authorized WebSockets; application cookies/Authorization; methods/query strings; streaming; malformed upstream 502; oversized request 413; revocation/shutdown/empty restart state. The RFC6455 fixture is intentionally small; Chrome uses its real WebSocket implementation in the separate Vite test.

Separate real Chrome/Vite controlled-host transport test passed: handoff/cookie attributes, assets/CSS, JS, client-side route, reload, real HMR update and changed DOM, all WebSocket URLs staying on the gateway origin, unrelated browser profile denied, and abort cleanup. After the final narrow application-header correction, focused HTTP/browser rerun: **3 passed, 0 failed**.

B2-C real Linux namespace/egress suite: **five groups passed**, including controlled private-host positive control then nft rejection, public HTTPS/DNS, restricted/mapped/IPv6 counters, redirects/DNS changes, helper hardening/failure/parent death/cleanup and W7. B2-D verifier/dispatcher, B1 lifecycle, B2-E resources, W7, permissions/Casual Chat regressions passed in the combined run. B2-E deterministic Python policy tests: **four groups passed**.

Production Vite build passed with the existing chunk-size warning. JS/Python syntax, JSON parsing and git diff --check passed. No baseline product failure is asserted: initial failures were development findings in the new fixtures, including incomplete copied Vite dependencies, invalid DELETE body framing, oversized-body connection handling and missing Playwright headless-shell revision. Existing installed Chrome was used instead of downloading a browser. No credentials are recorded in evidence.

## Remaining acceptance and UI/package status

**Full isolated Vite acceptance failed.** Standard Node/Vite inside the real B2-D command failed with `Fatal process out of memory: Failed to reserve virtual memory for CodeRange`. Bounded system-Node/JIT/thread/allocator experiments progressed further but encountered either unavailable WebAssembly under jitless mode or `WebAssembly.instantiate(): Out of memory: wasm memory`. No existing resource limit was raised or removed. The optional test retains a standard Vite command as a reproducible acceptance target. Resolving virtual-address reservations while retaining meaningful resource bounds is required before claiming the intended Vite workflow internally complete.

No renderer IPC/model operation creates previews, and no enabled Open action is shipped. The existing Background Commands card/Stop UI remains unchanged. Main-process status/open APIs are ready for a later gated card integration, but live preview status/Copy/Open UI wiring and Electron UI acceptance are **not implemented** in this stage. No new dashboard or styling was introduced. Capability discovery truthfully reports unavailable; models are not encouraged to call a disabled tool. Intended future trusted tool contract is `{background_command_id, guest_port}` only. Creation/status use the trusted session context; Open hands credentials directly to a browser and returns no credential.

No AppImage/deb artifact, installed package, complete resource/license bundle or packaged lifecycle was tested. The new connector is now required by manifest resolution, so any future resource set must include and hash it alongside worker/owner/policy/helper. Source-tree acceptance is not package qualification. Current evidence is Linux x86-64 only, not a new supported platform claim.

B2-E blockers remain: authoritative host-local exclusion during public host-address changes, release-qualified policy maintenance, complete pinned/license-compliant dependencies and AppImage/deb runtime qualification. Development activation remains prohibited. Remaining B2-F work: contained Vite runtime qualification, full isolated browser/HMR acceptance, gated existing-card integration/verification, and broader fault/load/abrupt-termination acceptance. Connection-flood exhaustion and a preview-specific abrupt parent SIGKILL test were not performed; underlying owner parent-death behavior was covered by B2-C.

## Reproduction

Use only the previously verified helper and disposable fixtures, outside an outer environment that denies sockets/netlink:

```sh
B2F_HELPER=/tmp/continuum-b2-a-backend/slirp4netns B2F_BROWSER=1 B2F_BROWSER_EXECUTABLE=/opt/google/chrome/chrome node --test tests/b2fPreviews.test.cjs
B2F_BROWSER=1 B2F_BROWSER_EXECUTABLE=/opt/google/chrome/chrome node --test tests/b2fGateway.test.cjs tests/b2fViteBrowser.test.cjs
B2F_HELPER=/tmp/continuum-b2-a-backend/slirp4netns B2F_VITE=1 node --test tests/b2fPreviews.test.cjs
```

The last command includes the known failing isolated Vite target; do not interpret the ordinary opt-in skip as its acceptance. Fixture environment variables exist only in tests and cannot bypass shipping readiness.
