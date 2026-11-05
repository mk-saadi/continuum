'use strict';
// Engineering-verified reconstruction for LOCAL, NON-DISTRIBUTABLE use only.
// Original selected helper/link inputs/upstream+distro sources are byte-identical.
// Logs, package inventory and tar metadata differ from the lost G.4 envelope.
// The original production archive pin in b2-g4-helper-candidate.json is unchanged.
//
// The single source of truth for the local-only identity is the shipped module
// used at runtime, so build-time assembly and the packaged AppImage cannot drift.
const { reviewArchiveSha256 } = require('../src/main/localDevelopmentNetwork');
module.exports = Object.freeze({
  reviewArchiveSha256,
  productionQualified: false,
});
