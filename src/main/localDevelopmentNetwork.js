'use strict';
// Local-development networking entitlement.
//
// Eligibility is code-owned and build-specific:
//   * Any unpackaged launch of this application (normal `npm run dev` /
//     `npm run start`, or the compatibility shim scripts/local-development-main.cjs)
//     is a source-local developer build.
//   * A packaged build whose package.json "main" is the code-owned
//     src/main/localDevelopmentEntry.js is the LOCAL DEVELOPER AppImage.
//     Normal production packaging keeps "main" as main.js and is never local.
//
// Neither environment variables, argv, renderer input, a manifest field nor
// model output can enable this. The dedicated profile from the earlier W7 work
// is gone: every eligible launch uses the primary application profile, and the
// independently pinned networking resources are still audited in
// networkDependencies before readiness ever opens.
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '../..');
const sourceResources = path.join(root, '.continuum-local/resources');
const PACKAGED_LOCAL_MAIN = 'src/main/localDevelopmentEntry.js';

// Code-owned local-only resource identity, shared with the build-time assembly
// scripts so there is a single source of truth. Production pins are unchanged.
const helperSha256 = 'dceac41dfbec04cfbcc68af73cae2353f1509adc45fe1a2441360f466110b980';
const reviewArchiveSha256 = '0f7217354527fd430406bc13d23b6d23535d2ce058c1d3f110bac298bc3d9acf';

let enabled = false;
let mode = null;

// Pure, code-owned eligibility decision. Exposed for deterministic tests; it
// consumes only the packaged flag and the application's own package.json "main"
// field. No external input participates.
function resolveEligibility({ packaged, mainField } = {}) {
  if (!packaged) return { eligible: true, mode: 'source' };
  return mainField === PACKAGED_LOCAL_MAIN ? { eligible: true, mode: 'packaged-local' } : { eligible: false, mode: null };
}

// The main field Electron actually loaded. app.getAppPath() is the packaged
// app.asar or the source application directory; reading its package.json is the
// same code-owned build identity the launcher used.
function runningMainField() {
  try {
    const appPath = require('electron').app.getAppPath();
    return JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8')).main ?? null;
  } catch { return null; }
}

function initialize() {
  const { app } = require('electron');
  if (!app || typeof app.isPackaged !== 'boolean') return false;
  if (enabled) return true;
  const decision = resolveEligibility({ packaged: app.isPackaged, mainField: runningMainField() });
  if (!decision.eligible) return false;
  enabled = true;
  mode = decision.mode;
  module.exports.mode = mode;
  module.exports.resources = mode === 'packaged-local' ? process.resourcesPath : sourceResources;
  return true;
}

function active() {
  if (!enabled) return false;
  try {
    const { app } = require('electron');
    if (!app) return false;
    if (mode === 'source') return !app.isPackaged;
    if (mode === 'packaged-local') return !!app.isPackaged;
  } catch { return false; }
  return false;
}

function buildLabel() {
  if (!active()) return 'Production';
  return mode === 'packaged-local'
    ? 'Local development · developer AppImage · NON-DISTRIBUTABLE'
    : 'Local development · source · NON-DISTRIBUTABLE';
}

function buildIdentity() {
  return Object.freeze({
    kind: 'continuum.local-development',
    version: 1,
    mode,
    productionQualified: false,
    active: active(),
  });
}

module.exports = { initialize, active, resources: sourceResources, resolveEligibility, buildLabel, buildIdentity, helperSha256, reviewArchiveSha256 };
