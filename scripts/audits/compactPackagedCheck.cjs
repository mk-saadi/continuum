'use strict';
// ASAR/Electron smoke, NOT an installed/released GUI or real-model acceptance.
// Uses current source and dependencies, temporary profiles and fixture repos.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-asar-check-'));
const stage = path.join(directory, 'stage');
const resultPath = process.argv[2];
async function main() {
  fs.mkdirSync(stage);
  for (const name of ['src', 'tests', 'scripts']) fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));
  // Dependencies stay outside ASAR, including native SQLite. This is a smoke
  // package, not electron-builder output or its networking resource gate.
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  const archive = path.join(directory, 'app.asar');
  await asar.createPackage(stage, archive);
  const electron = require('electron');
  const environment = { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1' };
  delete environment.CONTINUUM_NATIVE_TOOL_PROFILE;
  delete environment.NODE_TEST_CONTEXT;
  const budgetPath = path.join(directory, 'budget.json');
  const budget = spawnSync(electron, [path.join(archive, 'scripts/audits/compactPromptBudget.cjs'), '--output', budgetPath], { env: environment, encoding: 'utf8', timeout: 30000 });
  if (budget.status !== 0) throw Error('ASAR budget check failed:\n' + budget.stderr + budget.stdout);
  const suitePath = path.join(directory, 'suite.json');
  const suite = spawnSync(electron, [path.join(archive, 'tests/p2CompactNativeTools.test.cjs')], { env: { ...environment, COMPACT_SUITE_EVIDENCE: suitePath }, encoding: 'utf8', timeout: 60000 });
  const result = { method: 'Current source in temporary ASAR, Electron RUN_AS_NODE, NODE_ENV=production; dependencies outside ASAR; no GUI or inference',
    budget: JSON.parse(fs.readFileSync(budgetPath)), suiteExit: suite.status, suiteOutput: suite.stdout + suite.stderr,
    suiteEvidence: fs.existsSync(suitePath) ? JSON.parse(fs.readFileSync(suitePath)) : null };
  if (resultPath) fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  if (suite.status !== 0 || !result.suiteEvidence?.completedTests.length) throw Error('ASAR compact suite failed or did not execute:\n' + result.suiteOutput);
  const liveIndex = process.argv.indexOf('--live-case');
  if (liveIndex >= 0) {
    const livePath = path.join(directory, 'live.json');
    const live = spawnSync(electron, [path.join(archive, 'scripts/audits/compactRealModelCheck.cjs'), '--case', process.argv[liveIndex + 1], '--output', livePath], {
      env: environment, encoding: 'utf8', timeout: 900000,
    });
    result.liveModelExit = live.status;
    result.liveModel = fs.existsSync(livePath) ? JSON.parse(fs.readFileSync(livePath)) : null;
    if (resultPath) fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    if (live.status !== 0 || !result.liveModel?.completed) throw Error('Live ASAR model checks failed; inspect the saved evidence.');
  }
  console.log('ASAR/Electron production-mode prompt budget and compact suite passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
