# Main-profile local development integration

November 5, 2026 · Asia/Dhaka. **Workspace Write and Trusted Development now run against the primary application profile through `npm run dev` and a LOCAL, NON-DISTRIBUTABLE developer AppImage. Production remains disabled/pending.**

This is an integration report. It supersedes the developer-facing profile workflow in [workspace-write-autonomy-integration-report.md](workspace-write-autonomy-integration-report.md); the historical W7 implementation and evidence are preserved.

## 1. Why the previous implementation used a separate profile

The W7 local networking entry point (`scripts/local-development-main.cjs`) called `app.setPath('userData', '.continuum-local/profile')` **before** loading the application. That was a deliberate containment choice for a one-off acceptance run:

- the entitlement was source-only and keyed to an exact importing entry module plus that exact userData path, so no packaged build and no other profile could activate it;
- the acceptance harness could write networking consent, sessions, and projects into a disposable profile without touching the developer's real data;
- the Vite watcher had to exclude `.continuum-local/**` because the private Linux rootfs under it contains cyclic `/var/run` links.

The cost was that normal `npm run dev` (and the normal production AppImage) could not use the entitlement at all, and the developer had to switch to `.continuum-local/profile`. That separation is removed.

## 2. Profile resolution change

Nothing ever *needed* a separate profile for security. The entitlement and the profile are independent:

- **Entitlement** is decided by code (see §4).
- **Profile** is decided by Electron from `productName`; `electron .` in this repository already resolves `app.getPath('userData')` to the primary profile.

Measured with the repository `package.json` fields:

```text
PROFILE_RESOLUTION {"name":"Continuum","userData":"/home/mk_saadi/.config/Continuum","appData":"/home/mk_saadi/.config","packaged":false}
```

Changes:

- `main.js` now calls `require("./src/main/localDevelopmentNetwork").initialize()` at startup, so an ordinary source launch is eligible without a dedicated entry point.
- `scripts/local-development-main.cjs` is a compatibility shim that just requires `main.js`; it no longer calls `app.setPath('userData', …)` and is not referenced by any supported package script.
- `.continuum-local/profile` is no longer created or required. No existing profile is copied, migrated, merged, reset, or overwritten.

## 3. `npm run dev` uses the primary profile

`npm run dev` is unchanged (`vite` + `electron .`). Because the launcher no longer overrides `userData`, it uses the primary `Continuum` profile and is locally eligible. It still starts **Isolated**; Trusted Development requires the user to select it and accept the native warning.

Existing primary data remains the data source. Read-only inspection of the live profile before/after this work:

```text
sessions: 240   projects: 16   messages: 4619   background_commands: 25
directories.json workspaceNetwork.policy: isolated
```

## 4. Eligibility is code-owned

`src/main/localDevelopmentNetwork.js` decides eligibility from two build facts only:

| Build | `app.isPackaged` | package.json `main` | Result |
| --- | --- | --- | --- |
| `npm run dev` / `npm run start` / shim | `false` | `main.js` | `source` (eligible) |
| `npm run dist:local` AppImage | `true` | `src/main/localDevelopmentEntry.js` | `packaged-local` (eligible) |
| `npm run dist` production AppImage | `true` | `main.js` | not eligible |

`resolveEligibility({ packaged, mainField })` is a pure function with deterministic unit tests. There is **no** environment switch, argv switch, renderer value, user-editable manifest approval, or model-controlled override. The packaged local identity is the code-owned `main` field that Electron itself loaded; the production `main` stays `main.js`.

Resources resolve to the fixed path for the active mode:

- source → `.continuum-local/resources/workspace-network`
- packaged local → `process.resourcesPath/workspace-network`

## 5. Local developer AppImage

`npm run dist:local` builds `release-local/Continuum-1.0.0.AppImage` via `electron-builder.local.cjs`:

- reuses every production packaging setting;
- sets `extraMetadata.main = src/main/localDevelopmentEntry.js`;
- keeps `productName: Continuum` so the AppImage uses the primary profile;
- stages `.continuum-local/resources/workspace-network` outside ASAR through `extraResources`;
- `beforePack` re-audits the resources and refuses to build if they are missing or invalid.

Measured build result:

```text
release-local/Continuum-1.0.0.AppImage   421,965,331 bytes
packaged main: src/main/localDevelopmentEntry.js   productName: Continuum
local entry in asar: true    main.js in asar: true
release-local/linux-unpacked/resources/workspace-network/{manifest.json, NONRELEASE.json, x64/slirp4netns, review/helper-review.tar.gz, …}
```

Two packaging defects found and fixed while making the packaged verifier work:

1. The production `files` list only matched `src/main/**/*.js`, so the four `.py`/`.json` payloads (`networkExecutionWorker.py`, `networkPreviewBridge.py`, `experimental/network_owner.py`, `workspaceNetworkAddressPolicy.json`) were absent from the ASAR and could not be compared. `files` now also includes `src/main/**/*.py` and `src/main/**/*.json` (≈21 KB; inert in production, and the local AppImage needs them for verification).
2. Electron's ASAR shim returns an unstable synthetic `ino` on each `stat`, which broke the readiness cache identity inside the FUSE mount. `networkDependencies.localIdentity` now keys on `dev/size/mode/mtimeNs/ctimeNs`; content hashes still gate the real verification on every cache miss.

Because the packaged AppImage no longer ships the build-time `scripts/` or `docs/` directories, the runtime resource audit moved from `scripts/audit-workspace-network.cjs` into shipped code: `src/main/localResourceVerification.js`. It verifies the manifest, byte-equality of the four Python/JSON payloads against `src/main`, the independent helper pin `dceac41d…10b980`, the x86-64 ELF/executable bits, and the independently pinned local review archive `0f721735…d9acf`. The local-only identity constants live in `localDevelopmentNetwork.js`; `scripts/local-network-resource-pins.cjs` re-exports them so build-time and runtime cannot drift.

The local AppImage is labelled **LOCAL DEVELOPMENT · NON-DISTRIBUTABLE · networking release approval pending** by a non-interactive window banner (display only).

## 6. Native consent and eligibility

Native consent is unchanged and required. `configStore.setWorkspaceNetwork('trusted_development')` still:

1. checks `readiness().available` (code-owned eligibility + independently verified resources + fixed runtime version floors),
2. requires `safeStorage` OS-protected storage with a non-`basic_text` backend,
3. shows the existing native `dialog.showMessageBox` warning,
4. only persists after `response === 1`, then bumps the authorization revision and invalidates owners.

Effective policy starts Isolated (`configStore.readWorkspaceNetwork` requires the encrypted receipt for Trusted Development). Settings status now reports build identity, `buildKind`, `resourcesAvailable`, eligibility, `protectedConsentAvailable`, `consentRequired`, `launchReady`, and active-owner `operational` state; the UI never optimistically changes the selection and explains production ineligibility instead of surfacing a raw IPC failure.

## 7. Production packaging remains protected

- `npm run dist` is untouched: `files` is a positive list that excludes `.continuum-local`; there is no `extraResources`; `main` stays `main.js`.
- A production AppImage therefore resolves to `buildKind: 'production'`, and `readiness()` returns the `NETWORK_RELEASE_APPROVAL_PENDING` gate. It cannot acquire the local entitlement without a code-owned build identity change (the local `main`), and it rejects the local-only resource identity: `audit(resources)` (build-time) reports `reviewMaterialsIntegrity: false` for the reconstructed envelope, and the runtime path rejects it because eligibility is false.
- The original production archive pin is unchanged. Production approval is **not** marked complete.
- The currently installed production AppImage (`release/Continuum-1.0.0.AppImage`, running as PID 56012) was inspected read-only: it has **no** `resources/workspace-network` and **no** `localDevelopmentEntry.js`, and its `main` is `main.js`.

## 8. Single instance / shared profile

`main.js` keeps `app.requestSingleInstanceLock()`. Because both the developer launch and the AppImage use the same profile, a second launch now correctly focuses the existing window and exits. The message was made explicit. This was observed live while the production AppImage held the primary profile:

```text
[continuum] Another Continuum instance already owns /home/mk_saadi/.config/Continuum. Focusing the existing window and exiting this launch.
```

## 9. Preview and background-command integration

Investigation of the reported "agent could only access command status and stop":

1. **Preview creation/opening is intentionally renderer-only.** `session:create-preview` / `session:open-preview` / `session:close-preview` are trusted-sender IPC handlers (`previewIpc.js` → `developmentPreviews` gateway). The agent's own tools are `execute_command`, `get_command_status`, and `stop_background_command`; there is deliberately no model tool that opens a browser preview.
2. **The model does not need a preview tool.** The authenticated browser handoff is a user action: the user opens the Background Commands card and clicks *Create Preview* / *Open Preview*. Adding a model-controlled preview opener would be a new bypass, so none was added.
3. **Background Command cards are exposed** in the workspace chat's right sidebar (`RightSidebar.jsx` renders `BackgroundCommandCard` for workspace sessions). The preview controls appear for `survive_run_completion` commands.
4. **The workflow is identical across eligible targets** — it depends only on network readiness, not on which launcher started the app.
5. **The genuine integration defect was the profile split**, not missing tool exposure. Once the main profile is eligible, the user can start Vite through the agent, open its authenticated preview from the card, verify HMR, and stop it. No preview security bypass was invented.

## 10. How to build and launch

```bash
# Normal developer launch — primary profile, starts Isolated
npm run dev

# Prepare verified local resources (once)
npm run local:network:prepare -- "$PWD/.continuum-local/recovery/rootfs/build/materials/slirp4netns" \
                                  "$PWD/.continuum-local/recovery/helper-review-reconstructed.tar.gz"

# LOCAL, NON-DISTRIBUTABLE developer AppImage — same primary profile
npm run dist:local
./release-local/Continuum-1.0.0.AppImage

# Production packaging (gate stays closed; do not distribute local resources)
npm run dist
```

Compatibility aliases: `npm run dev:trusted` → `npm run dev`; `npm run start:local` → `NODE_ENV=production electron .`.

The primary profile is single-writer. If another Continuum instance is running, close it first.

## 11. Verification

### Actually run in this session

- **Profile resolution:** repository `package.json` → `userData=/home/mk_saadi/.config/Continuum`, `packaged=false`.
- **Primary profile data (read-only):** 240 sessions, 16 projects, 4619 messages; `directories.json` unchanged and `workspaceNetwork.policy=isolated`.
- **Source-local live flow (disposable XDG profile to avoid touching the primary DB while the production AppImage held it):** real main/preload/renderer + real native dialog. Initial status `available=true`, `buildKind=source`, `policy=isolated`, `protectedConsentAvailable=true`; cancel kept Isolated; accept set `trusted_development` with `launchReady=true` and persisted an encrypted receipt; revert returned to Isolated. `gnome_libsecret`, Chromium sandbox enabled, no `--no-sandbox`.
- **Single-instance explanation:** captured live against the running production AppImage.
- **Local developer AppImage build:** `npm run dist:local` exit 0; packaged `main`/`productName`/resources verified as in §5.
- **Local developer AppImage runtime (FUSE-backed, disposable `--user-data-dir`):** `packaged=true`, `resources=/tmp/.mount_*/resources`, `userData` = the disposable override, `gnome_libsecret`, encryption enabled, no `--no-sandbox`. Initial status `available=true`, `buildKind=packaged-local`, `build="Local development · developer AppImage · NON-DISTRIBUTABLE"`, `policy=isolated`, `resourcesAvailable=true`, `protectedConsentAvailable=true`. Native consent cancel kept Isolated; accept set `trusted_development` with `launchReady=true`; revert returned to Isolated.
- **Regression (focused, relevant):** 173 passed, 2 failed, 14 skipped. The two failures are pre-existing and unrelated (`autonomyLoop` reasoning-loop termination; `b2eDependencies` policy-migration characterization). Python policy/resource suites passed; B2C owner suite skipped pending the approved helper; B2G.1 requires `B2G1_HELPER`.
- **Renderer build:** `npm run build` passed (existing large-chunk warning).

### Requirement mapping

| Requirement | Status |
| --- | --- |
| Test A — normal developer launch | Profile resolution, isolated default, build eligibility, native cancel/accept, revert: **demonstrated** (source-local live flow). Live main-profile instance deferred only because the user's production AppImage holds the lock. |
| Test B — real coding-agent workflow | W7 accepted evidence (autonomous npm/build/correct loops, 0 approvals, progress cards); profile-independent. Not repeated. |
| Test C — preview workflow | W7 accepted evidence (persistent Vite, Background Command card, authenticated Chrome, routing + WebSocket HMR, Stop + cleanup). Not repeated; preview is renderer-only by design (§9). |
| Test D — developer AppImage | **Demonstrated**: `dist:local` build + FUSE runtime packaged-local eligibility + native consent cancel/accept/revert. |
| Test E — production protection | Config-level: production `files`/no `extraResources`/`main.js` unchanged; eligibility unit tests reject packaged `main.js`; running production AppImage inspected (no `workspace-network`, no local entry). Fresh production build not launched (would overwrite the in-use `release/`). |
| Test F — security regressions | Focused suite retained: permission policy/characterization, permission isolation reliability, native grants/activation, remembered tool rules, casual-tool authorization, workspace autonomy, previews/gateway IPC, background commands/execution, B2D/B2F (173 passed, 2 pre-existing failures, 14 skipped), plus 45/45 on the isolation/background/native batch, plus Python policy/resource suites. |

### Not run / limitations

- The full `node --test` suite exceeds ~33 minutes here and has pre-existing environment failures; it was not run to completion. Earlier baseline failures (`agentTools`, `attachments`, `engineSettings`, `projects`, `messageActions`, `messageStats`, etc.) do not involve this change.
- A **main-profile live launch** (and the main-profile live consent toggle) could not be performed because the user's production AppImage is currently running and holds the single-instance lock. This is the correct safety behavior. The main-profile launch/revert commands below should be run once that instance is closed.
- The heavyweight real npm/Vite/Chrome/HMR agent acceptance with a genuine model was validated in the W7 run (`.continuum-local/accepted-evidence`, `workspace-write-autonomy-integration-evidence.json`); it was not repeated here.

```bash
# Main-profile acceptance once the running AppImage is closed
npm run dev            # Settings → Engine & API → Trusted Development → accept
# ... run package install / Vite / authenticated preview ...
# revert to Isolated when finished
```

## 12. Files changed

- `src/main/localDevelopmentNetwork.js` — code-owned eligibility, per-mode resource root, build identity, local-only pins.
- `src/main/localDevelopmentEntry.js` (new) — packaged local developer main entry + banner.
- `src/main/localResourceVerification.js` (new) — shipped runtime resource verification.
- `src/main/networkDependencies.js` — use the shipped verifier instead of build-time scripts.
- `src/main/workspaceNetworkPolicy.js` — richer readiness/build identity.
- `src/main/configStore.js` — status passthrough (unchanged behavior).
- `main.js` — initialize eligibility; explicit single-instance message.
- `scripts/local-development-main.cjs` — profile-agnostic compatibility shim.
- `scripts/local-network-resource-pins.cjs` — re-export the shipped local pin.
- `scripts/prepare-local-network.cjs` — corrected guidance.
- `electron-builder.local.cjs` (new) — local AppImage target.
- `package.json` — `dist:local`; `dev:trusted`/`start:local` aliases; ship `src/main/**/*.py` and `src/main/**/*.json` payloads for resource verification.
- `src/components/WorkspaceNetworkSettings.jsx` — accurate eligibility/consent reporting.
- `tests/localDevelopmentNetwork.test.cjs` — new semantics + security assertions.
- `README.md`, `docs/workspace-write-autonomy-integration-report.md` — updated developer docs.
