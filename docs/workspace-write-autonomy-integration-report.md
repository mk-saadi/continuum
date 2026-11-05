# Workspace Write autonomy integration

November 4, 2026 · Asia/Dhaka. **Autonomous local coding and real Trusted Development npm/Vite/Chrome acceptance passed. Production approval remains pending.**

> **Update (main-profile local development integration):** The `.continuum-local/profile` separation and the `dev:trusted`/`start:local` dedicated-profile launch described below are **superseded**. Normal `npm run dev` and the `npm run dist:local` developer AppImage now use the existing primary profile directly and keep the same code-owned local entitlement, native consent, and resource verification. See [main-profile-local-development-integration-report.md](main-profile-local-development-integration-report.md). The historical evidence in this report is retained unchanged; only the developer-facing commands in section 10 are updated.

## 1. Actual application and rejection

The running primary application was PID 38603, `/tmp/.mount_Contin7dnb5F/continuum`, launched from the repository's `release` directory with profile `/home/mk_saadi/.config/Continuum`. This is a FUSE-mounted AppImage, not the Vite source-development process or installed deb. It was left running and unchanged.

Read its actual ASAR policy and resource directory. Its readiness function unconditionally returns unavailable, with the historical G.2 blockers. Its resources contain `app.asar` and `app.asar.unpacked`, **no `workspace-network` directory**. This explains the exact observed missing-manifest IPC exception. Read-only recent session/project metadata also confirms real workspaces with Workspace Write selected. The active command policy already allowed ordinary commands when its sandbox facts were present; it separately prompted for package classifications and unavailable sandbox conditions. The blanket every-command symptom was not reproduced as a universal backend rule. The policy matches the pre-integration source behavior; a stale generated main-process bundle is not needed to explain the failure. The running AppImage cannot acquire these source edits without a new build/launch.

The path is `WorkspaceNetworkSettings` → `src/preload.js` narrow APIs → trusted `ipcHandlers` registration → `configStore.setWorkspaceNetwork` → `workspaceNetworkPolicy.readiness` → `networkDependencies.resolveBundled` → manifest/digest/ELF checks → fixed-path `networkRuntimePrerequisites.assertVersions`. Readiness previously always returned false even after a successful resource resolution. Normal Electron Builder excludes the resources. Prior G.5/G.6 enabled qualification archives were separate temporary artifacts, not production promotion.

## 2. Local development and resource handling

Added `local:network:prepare`, `dev:trusted` and `start:local` targets. The dedicated main-process entry point uses `.continuum-local/profile`, names and visibly labels the app **LOCAL DEVELOPMENT · NON-DISTRIBUTABLE**, and initializes a source-only local networking entitlement. Initialization requires its exact importing entry module; packaged applications and other profiles are rejected. There is no runtime environment switch, renderer override, model argument or manifest approval flag. Vite explicitly excludes `.continuum-local/**` from its file watcher because the private Linux runtime rootfs contains cyclic `/var/run` links; without this exclusion `dev:trusted` could fail with `ELOOP` before Electron started.

Local resources live at the fixed project path `.continuum-local/resources/workspace-network`, outside ASAR. Preparation reuses assembly/audit, current payload equality, the independently pinned selected helper, a complete independently pinned review archive (the original identity or the separately verified local reconstruction described below), executable/ELF checks and runtime floors. Existing output is verified, never overwritten. `.continuum-local` is ignored and excluded by normal packaging's positive file list. Normal `dev`, `start` and `dist` retain the production gate.

Source-local Workspace Write rejects project trees overlapping the running Continuum source or its ancestors. This prevents the agent from changing its own trusted backend, dependencies, profile or resource controls. Use a separate project workspace; Read Only remains available for this source tree. Full Access and normal packaged mode semantics are unchanged. Local eligibility does not claim packaged release approval. Owner startup still verifies namespaces, addresses and effective cgroup/resource enforcement. Version probes alone do not establish kernel/session support.

## 3. Resource recovery

Before reproduction, no matching helper/archive was found in the checked `/tmp`, `/var/tmp`, project outputs, home directory, Downloads, caches or retained Continuum packages. The active and retained normal artifacts have no networking resources. The user confirmed no backup of the temporary G.4/G.5 bundle.

Added `scripts/recover-workspace-network.py`; persistent recovery inputs/logs/rootfs live under `.continuum-local/recovery`. All three original source inputs downloaded and matched the candidate JSON pins:

- Ubuntu Base: `242cd8898b33ea806ef5f13b1076ed7c76f9f989d18384452f7166692438ff1a`.
- slirp source: `26337b2ab119f7e64855e4617e91cf1fa7faeacd50329b4f262033e18e2b083b`.
- libslirp source: `d2567fa06a6357c7755d61c67293b2c0bf069b3f2173bde6b76cf768529a1938`.

The documented signed snapshot at `20261030T000000Z` returned HTTP 503 for all three suites. A separately logged attempt uses Ubuntu's signed live archive with explicit original libc/GLib/libseccomp/libcap/GCC package versions. No host package installation or privilege escalation inside the build root is required: Bubblewrap maps the ordinary user to namespace root. The rebuilt helper identity equals `dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980`.

All 18 linker inputs independently matched the original inventory; see `.continuum-local/recovery/link-input-comparison.json`. The original review archive also contains build logs, generated trees and tar metadata. It was **not** reproduced byte-for-byte. The new local envelope is `0f7217354527fd430406bc13d23b6d23535d2ce058c1d3f110bac298bc3d9acf`, 123,885,473 bytes. All 84 material checksums, all 17 original distro-source pins, both upstream-source pins and all 18 linker inputs verify. Relinking from the preserved inputs reproduces the exact selected helper. The original archive had 91 material hashes; this reconstruction includes new logs, inventories and generated/tar metadata and is not described as that historical archive.

The original **production** archive pin remains unchanged. `local-network-resource-pins.cjs` adds one fixed, engineering-verified local-only identity; it is not an environment option, renderer assertion, user-supplied manifest approval or production entitlement. Default release assembly/audit rejects that new envelope. The dedicated local path accepts it only with the independently pinned original helper and matching payloads. This is an integrity/source-accounting review for private development, not approval of legal sufficiency or public delivery. Durable proof: `workspace-write-local-resource-reconstruction.json`.

All recovered/generated bytes are under ignored `.continuum-local/recovery`; staged runtime resources are under `.continuum-local/resources`. No permanent resource depends on `/tmp`. Disposable workspaces and existing worker scratch still use temporary storage.

## 4. Command approvals and recovery

Workspace Write shell/package/lifecycle commands now authorize from backend containment facts and the verified `bwrap_workspace` profile. Command spelling does not confer authority. Missing or incompatible sandbox facts reject execution with an actionable error; approval cannot turn Workspace Write into host execution. Ask for Approval continues prompting.

Workspace file deletion remains fingerprint-bound and attempts the existing recovery capture. Incomplete capture is reported truthfully but no longer causes redundant approval inside the already authorized workspace. Checkpoints remain unpinned and retain the existing restore/retention behavior. Single-use native grants, mode/revision checks, snapshots, filesystem masks, Git metadata protection and owned-process lifecycle remain in force.

Native workspace directory listings/searches also validate canonical scope in both guard and dispatcher. A different native read route cannot bypass the shell's workspace boundary. Full Access and Casual Chat behavior is unchanged; no fifth mode or P3 tab was added. Existing Git publication/dirty-worktree safeguards remain.

## 5. Effective capabilities and settings

`executionCapabilities` derives networking from the protected current selection and backend readiness. Isolated explicitly says downloads cannot work, only local dependencies can be used, and unchanged network operations must not be retried. Trusted capability text describes package downloads, host/private IPv4 exposure, unavailable external IPv6, filesystem/process restrictions and authenticated previews. Unavailable networking includes its actual backend reason/code. Existing prompt-builder and per-turn environment refresh paths consume this dynamic section.

Network-setting revisions bind issued shell grants and live command validation. A setting change rejects stale grants and invalidates network owners; the model cannot preserve an old networking grant. Existing session permission revisions remain authoritative. Local readiness caches successful byte verification only while file real paths, device/inode, size, mode and nanosecond mtime/ctime remain unchanged, including the fixed runtime executables and source payloads. Changes force complete revalidation; a same-size/same-mtime mutation regression verifies rejection. This avoids repeatedly hashing a 119 MB archive and spawning version probes during live status polling.

Settings IPC now includes build identity, effective selection, protected-consent availability, whether consent is required, launch eligibility and active-owner operational status. The option is disabled when unavailable or protected storage is unavailable. Primary status copy is concise; technical errors remain in diagnostics. Selection failures do not optimistically change the displayed policy. The shared custom SelectField had discarded child-option disabled flags; disabled state now reaches both its native select and visible menu buttons. A real renderer test clicks the unavailable visible option and verifies zero networking IPC mutations. Cancelling native consent does not change the execution-authorization revision or interrupt existing commands. No primary profile/settings/database were edited.

## 6. Actual workflow and npm results

The new real-dispatcher acceptance performs six commands with no `permissionGranted` or approval-handler grant: inspect `package.json`, create source, `npm install --offline --no-audit --no-fund ./local-dependency`, build, correct source, build again. All run in the real Bubblewrap workspace executor, with recovery snapshots. This proves local npm operation and autonomous sandbox execution, not internet downloads.

The deterministic `engine:chat` IPC regression verifies zero command approval events and persisted progress cards. The actual local application main/preload/renderer was also launched with Chromium sandboxing, native consent, encrypted `gnome_libsecret` storage and a separate profile. Actual Settings cancellation, acceptance and protected restart passed. The current host is Pop!_OS 24.04 LTS, kernel `6.17.9-76061709-generic`; all fixed runtime floors pass. This qualifies this exercised host configuration, not every Linux distribution.

The live default dispatcher downloaded Vite 6.4.3 and is-number 7.0.0 with normal npm lifecycle scripts. The sentinel/cache lifecycle assertion passed. No command approval was granted: the harness throws if a command asks for one. A standard persistent Vite process, real Chrome and authenticated preview passed as detailed below.

A genuine already-running local Qwen model was separately exercised through the app's real model transport, with a keyless loopback provider in the disposable profile. There was no model-response, backend or tool-result substitution, no primary provider edit and no server restart. The genuine Send workflow completed six separate model-driven commands with no approvals, a local npm install, source correction and actual build outputs `42` and `43`. The real renderer displayed all six tool cards. A second genuine model-started `sleep 30` was cancelled using the real Stop button, returned the run to idle and requested no approval. The accepted six-command transcript was checked against persisted native results when resuming visual/Stop verification after correcting a card-label selector; no tool result was fabricated or rerun merely to obtain a screenshot. Screenshots and full transient records are retained in `.continuum-local`; concise durable evidence accompanies this report.

## 7. Security and permission-mode results

Real autonomous commands could not read a host-private sentinel or write the corresponding host path. A write to private sandbox `/tmp` is allowed and was checked to leave host `/tmp` untouched. Native read/list/search traversal is rejected. Cancellation stops a running command. Setting changes invalidate issued native grants. Existing regression coverage checks forged grants/plans, filesystem/symlink/socket/environment masks, session ownership, permission downgrades, no host fallback, recovery and preview authentication.

Ask for Approval prompts and remains offline even when global Workspace Write networking is Trusted Development; Read Only blocks commands/writes; Casual Chat and Full Access frozen behavior checks pass. The supervised pending-deletion revocation test now explicitly uses Ask for Approval, preserving its purpose after autonomous deletion changed.

The actual local Trusted Development run denied nft mutation and external IPv6, exposed no inherited namespace handles, and hid the host-home sentinel from a package lifecycle script. Effective kernel values were memory.max `1073741824`, memory.swap.max `0`, pids.max `128`, cpu.max `200000 100000`, memory.oom.group `1`. Credential-free preview access returned 403. After Stop the scope disappeared and the old preview refused connections. Existing mode/session/forged-context/expiry and aggregate-limit regressions remain separate from this live subset; no complete historical fault matrix is relabeled as new testing.

## 8. Verification

Final relevant suite: **196 passed, 0 failed, 1 skipped**, 197 groups. The reproduced helper enabled the real assembly case. The remaining skip requires the lost original production review archive; the new local archive is independently tested and is not substituted into that historical test. Covers permission policy/characterization, native grants, autonomy, recovery, mode revocation, Casual Chat, filesystem/runtime/Git/socket masks, B1 registry/IPC and preview gateway/IPC, consent and production gates. Final log: `/tmp/workspace-integration-final-signoff.log`.

Production renderer build passed (existing large-chunk warning). Real Electron settings fixture passed, using a sandboxed renderer. Actual source-local application launch/status/badge check passed with Chromium sandboxing enabled, using `.continuum-local/profile`. Syntax/AST and changed-file whitespace checks passed. Initial failures included obsolete package/uncovered-deletion approval expectations, a synchronous readiness hot path that exhausted the first Vite lifetime, and state-dependent UI selectors/model-picker/wrong guest-port fixture setup. The genuine UI fixture also required the saved loopback provider’s normal cloud model descriptor and the rich renderer’s singular card label; one exploratory model turn omitted its final build and was not accepted. The final model turn performed all six commands without follow-up. These were corrected; they are not counted as passes. No historical full B2 matrix was repeated.

## 9. Preview and background lifecycle

The actual local run started Vite as an owned B1 persistent command, completed its run, obtained later-run access and created/opened its preview through the real Background Commands card. A host bind-only probe confirmed no raw host Vite listener. Real Chrome loaded JavaScript and CSS, handled client routing/reload, established same-origin WebSocket HMR and observed a source edit. Credential-free HTTP stayed 403. The actual Stop button closed the server, authenticated Chrome access and the gateway. The network-owner registry emptied and the resource scope disappeared. The run reverted to Isolated. No Full Access or per-command approval was used.

Accepted evidence is copied to `.continuum-local/accepted-evidence` and summarized in `workspace-write-autonomy-integration-evidence.json`. Earlier failed attempts remain distinct and are not counted as acceptance.

## 10. Production decision and developer commands

Production remains disabled. The appended solo-maintainer section in `b2-g5-release-decision-checklist.md` reduces the remaining human review to exact source/notices/relink delivery, explicit maintenance commitments, and frozen-artifact production authorization. One maintainer can accept all three; no extra employee/team is required. No acceptance is recorded here. Production promotion still requires a reviewed code-owned gate/build change and packaged acceptance, never the local initializer.

The resources are already prepared in this checkout. To prepare them again from the persistent verified local artifacts:

```sh
npm run local:network:prepare -- "$PWD/.continuum-local/recovery/rootfs/build/materials/slirp4netns" "$PWD/.continuum-local/recovery/helper-review-reconstructed.tar.gz"
npm run dev
```

Or build the LOCAL, NON-DISTRIBUTABLE developer AppImage (same primary profile):

```sh
npm run dist:local
```

Both targets use the existing primary profile. `npm run dev` starts Isolated; select a model/provider, connect a project (a workspace **outside the Continuum source tree** for Workspace Write), and in Settings choose Trusted Development and accept the actual native warning. Protected OS storage, fixed runtime versions and real owner/cgroup startup must succeed. Then install packages, run bounded Vite with `survive_run_completion: true`, create/open the authenticated preview, verify HMR, stop the owned command and revert to Isolated. The closed test-only profile was archived under `.continuum-local/accepted-evidence/profile` before handoff. The normal production AppImage does **not** gain local entitlement.

To attempt recovery without replacing pins:

```sh
python3 scripts/recover-workspace-network.py
# Only when the documented snapshot is unavailable; exact critical versions remain pinned:
python3 scripts/recover-workspace-network.py --archive-mirror
```

The script retains existing material and refuses to overwrite a completed build directory. The original production review-archive pin remains unchanged; the local-only reconstruction has its separate fixed identity. Preserve generated artifacts in `.continuum-local`, not `/tmp`, and do not commit or distribute them as an approved release.

## Final recovery outcome

Helper and all linker inputs reproduced exactly; the original archive envelope did not. Its verified reconstruction is separately pinned only for non-distributable local use. Native consent, real npm, persistent Vite, authenticated Chrome/HMR and cleanup passed. Public production approval remains unfilled.

Final verification also replaced two pre-existing fixed background startup/output sleeps with bounded causal checks and guaranteed fixture cleanup; an earlier parallel-load timing failure and its cascading failure remain in accepted-evidence as failed attempts. Final regression concurrency was four, with all assertions retained. The original AppImage and pre-existing local model server remain running; the accepted Vite scope is gone and its old preview is closed. No commit, push, reset, stash, clean, host package installation or primary settings/conversation write occurred. Initial unrelated tracked/untracked UI work was preserved; the shared dropdown received only the necessary disabled-state fix.
