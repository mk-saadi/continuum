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
