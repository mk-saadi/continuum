# B2-G.5 release decision — PENDING / DO NOT DISTRIBUTE

Review candidate: slirp4netns 1.3.7 (`7ea080d8635bc85487e232ec178701c6864151c9`), binary SHA-256 `dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980`. Review archive: `helper-review.tar.gz`, SHA-256 `676fcef46f406b7511c64f638114a45dd9f38951899e3461e0d7e2c53e0e5225`. Approval applies only to those exact materials; rebuilding requires artifact review again.

Technical inventory: slirp4netns/Parson, libslirp 4.9.7 (`ce12dcddf710a71dc0de6450ec95edbadf8e9f66`), GLib 2.72.4-0ubuntu2.10, libseccomp 2.5.3-2ubuntu3~22.04.1, glibc 2.35-0ubuntu3.15, GCC runtime 11.4.0-1ubuntu1~22.04.3. libcap 1:2.44-1ubuntu0.22.04.3 is a build/header dependency, absent from the final linked closure. Eighteen actual link inputs are individually hashed in the candidate inventory.

- [x] Binary and independently pinned review-archive identities rechecked.
- [x] All 91 archive material hashes rechecked against archive-contained SHA256SUMS.
- [x] Exact upstream and distro source archives, patches/descriptors, link map, saved objects/libraries, generated build trees, notices/license texts and build scripts are present.
- [ ] Responsible reviewer accepts corresponding-source completeness and delivery for the exact distribution channel.
- [ ] Responsible reviewer resolves static LGPL relinking/material delivery for GLib, libseccomp and glibc, applicable per-file notices, and GCC runtime exception applicability.
- [ ] Confirm recipient-facing build/relink instructions are sufficient; see the technical relinking addendum in the G.5 report. Historical successful relinking alone is not legal approval.
- [ ] Assign and obtain explicit acceptance from a security maintenance owner. No person is appointed by this record.
- [ ] Owner accepts helper/embedded-library advisory monitoring, distro security tracking, triage/response times, withdrawal policy, rebuild/repin/retest procedure and address-policy review before its December 3, 2026 UTC deadline.
- [x] Normal FUSE-backed AppImage GUI/restart and separate internal NONRELEASE native-consent/npm/Vite/Chrome/HMR/card/lifecycle acceptance pass on the candidate host.
- [x] Complete actual installed deb acceptance in the disposable Ubuntu 24.04.5 x86-64 guest specified in G.6, with Pop!_OS bubblewrap 0.11, required namespace policy, systemd/cgroups and encrypted secret storage. Normal closed-gate GUI and separate NONRELEASE native-consent/npm/Vite/Chrome/HMR/Stop/revocation/shutdown acceptance passed.
- [x] Complete the AppImage enabled packaged workflow/fault/card gates recorded in the adjacent report/evidence. This does not qualify the installed deb.
- [ ] Review final artifact identities and authorize the smallest production eligibility change only after every condition passes.

Required approval record (currently unfilled):

| Decision | Responsible approver | Date | Status / evidence |
| --- | --- | --- | --- |
| Exact source/notices/relink redistribution materials | Unassigned | — | Pending |
| Source delivery channel and relinking instructions | Unassigned | — | Pending |
| Security maintenance ownership and response commitment | Unassigned | — | Not accepted |
| Runtime/platform qualification | Unassigned | — | Engineering acceptance passed for exact G.6 guest/artifacts; release review pending |
| Production activation | Unassigned | — | Disabled |

This is an engineering handoff, not legal advice or an approval. Evidence: `b2-g4-helper-candidate.json`, G.4 report/evidence, and `b2-g5-installed-runtime-release-signoff-report.md` / `b2-g5-installed-runtime-release-signoff-evidence.json`. No signature, date or accepted responsibility may be inferred from package maintainer metadata.

## B2-G.6 installed-deb acceptance — November 4, 2026

Engineering qualification is complete for the actual installed NONRELEASE deb on Ubuntu 24.04.5 amd64, kernel `6.8.0-147-generic`, systemd/libpam-systemd `255.4-1ubuntu8.18`, Pop!_OS bubblewrap `0.11.0-2~1750183577~24.04~313c27a`, and the explicit guest-only namespace/display/secret-service configuration in the [G.6 report](b2-g6-installed-deb-acceptance-report.md). This does not declare stock Ubuntu noble compatible: its default bubblewrap and user-namespace policy were insufficient.

Closed deb SHA-256: `5780b4081baa528c587d9d0d0f64d43399cca4b38d5c74c319cb310bb010af65`. Accepted enabled, guest/profile/hash/24-hour-bound NONRELEASE qualification deb SHA-256: `375abebec1f902879eba1308f284c86335f22b9bab3d52c31e579195faea88f8`. Helper/review pins above are unchanged. Normal installed GUI/default/rejection passed twice. Enabled native consent/protected restart, real npm, Vite, authenticated Chrome/HMR, Background Commands persistence/Create/Open/Stop, effective cgroups and five selected lifecycle/fault cases passed. G.5 AppImage-only cases remain separately identified. Guest cleanup and graceful VM shutdown passed.

Final new tests: 2/2 unit tests and 4/4 installed GUI/harness scripts, including 5/5 lifecycle cases; zero final failures/skips. Earlier setup failures are disclosed separately in the [evidence](b2-g6-installed-deb-acceptance-evidence.json). Production build and syntax/whitespace checks pass. Shipping readiness remains closed; normal ASAR contains no qualification module.

**Remaining release blockers: exact-material redistribution/source-delivery approval and accepted security maintenance ownership.** Approver, acceptance date, distribution channel and response commitments remain unfilled. Production activation requires a separate evidence-backed release decision after those human requirements are satisfied. No production entitlement or human signature is supplied by these technical results.

## Solo-maintainer promotion decision (still pending)

One person may review and accept all the decisions below as Continuum's sole maintainer. No additional employee or external security team is required. Ownership alone does not fill any approval field.

Before activation, record an explicit dated decision covering:

1. **Exact materials and delivery:** accept the helper `dceac41d…10b980`, review archive `676fcef4…e5225`, recipient-facing corresponding source/notices/relink instructions (including G.5's addendum), and the actual public delivery URL/channel. Verify the full hashes above, not these abbreviations.
2. **Maintenance commitment:** accept advisory monitoring for the helper and embedded libraries, triage/response and withdrawal commitments, rebuild/repin/retest responsibility, and address-policy review before December 3, 2026 UTC. Write the actual commitments and dates; none are inferred.
3. **Production promotion:** review frozen AppImage/deb identities and qualification evidence and explicitly authorize production eligibility for those resources/platforms.

After that recorded decision, the maintainer's reviewed production change must open the code-owned release gate in `workspaceNetworkPolicy.js` and release assembly in `assemble-workspace-network.cjs`, add audited outside-ASAR resources and the existing runtime dependency floors to normal Electron Builder configuration, and run packaged acceptance on the frozen output. Do not copy the local-development initializer into a production entry point. `npm run dist` currently remains closed and excludes `.continuum-local` and its launcher/profile.

Missing historical artifacts are an additional engineering blocker to promotion. The integration work does not approve replacing either independent artifact pin or treating regenerated logs/tar metadata as the original review archive.

The local integration recovered the exact selected helper and all 18 linker inputs. Its **new local-only** source/relink envelope is `0f7217354527fd430406bc13d23b6d23535d2ce058c1d3f110bac298bc3d9acf` (84 verified materials, including all original upstream/distro source pins). The historical `676fcef4…e5225` envelope was not reproduced. If the maintainer chooses the reconstruction for public delivery, explicitly review and approve that exact new envelope and change the production pin only in the separately authorized promotion change. The local whitelist is not that approval. See `workspace-write-local-resource-reconstruction.json`; all decision fields above remain pending.
