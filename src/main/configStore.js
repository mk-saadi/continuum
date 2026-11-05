'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let networkDecisionRevision = 0;
let networkAuthorizationRevision = 0;
const networkAuthority = Symbol('trusted settings network decision');
const configFile = () => path.join(app.getPath('userData'), 'directories.json');
function validateIdleTimeout(value) {
  if (![-1, 5, 15, 60].includes(value)) throw new Error('Invalid engine idle timeout.');
  return value;
}
function validatePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
    throw new Error('Choose an absolute directory path.');
  return path.resolve(value);
}
function getConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configFile(), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Existing installations keep using their data until explicitly migrated.
  const root = app.getPath('userData');
  const legacy = fs.existsSync(path.join(root, 'memory_palace.db'));
  return {
    workspaceNetwork: readNetworkDecision(saved),
    gitIdentity: require('./gitIdentity').validateIdentity(saved.gitIdentity),
    extraReadOnlyRuntimePaths: saved.extraReadOnlyRuntimePaths ?? [],
    engineIdleTimeoutMinutes: validateIdleTimeout(saved.engineIdleTimeoutMinutes ?? -1),
    modelDirectory: validatePath(saved.modelDirectory ?? path.join(require('node:os').homedir(), 'Desktop', 'LLM_Models')),
    appDataDirectory: validatePath(saved.appDataDirectory ?? (legacy ? root : path.join(root, 'App_Data'))),
  };
}
function saveConfig(patch, authority) {
  if (Object.hasOwn(patch, 'workspaceNetwork') && authority !== networkAuthority)
    throw Object.assign(new Error('Use the trusted networking settings flow.'), { code: 'WORKSPACE_NETWORK_TRUST_REQUIRED' });
  const previous = getConfig();
  const config = { ...previous, ...patch };
  config.workspaceNetwork = require('./workspaceNetworkPolicy').normalize(config.workspaceNetwork);
  // Only the elevated tier re-verifies availability before it can be stored;
  // standard outbound and isolated selections stay valid either way and are
  // reported honestly through the runtime status instead.
  if (config.workspaceNetwork.policy === 'trusted_development' && !require('./workspaceNetworkPolicy').readiness().available)
    throw Object.assign(new Error('Networking is not ready for activation.'), { code: 'WORKSPACE_NETWORK_NOT_READY' });
  validateIdleTimeout(config.engineIdleTimeoutMinutes);
  config.gitIdentity = require('./gitIdentity').validateIdentity(config.gitIdentity);
  for (const key of ['modelDirectory', 'appDataDirectory']) config[key] = validatePath(config[key]);
  config.extraReadOnlyRuntimePaths = require('./sandboxFilesystem').validateExtraPaths(config.extraReadOnlyRuntimePaths ?? [], { maskedPaths: [config.appDataDirectory, app.getPath('userData')].map(p => { try { return fs.realpathSync(p); } catch { return p; } }) });
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  const temporary = configFile() + '.tmp';
  const persisted = { ...config };
  if (config.workspaceNetwork.policy === 'trusted_development') {
    const { safeStorage } = require('electron');
    persisted.workspaceNetworkReceipt = safeStorage.encryptString(JSON.stringify(config.workspaceNetwork)).toString('base64');
  }
  fs.writeFileSync(temporary, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, configFile());
  return config;
}
function readNetworkDecision(saved) {
  const policy = require('./workspaceNetworkPolicy');
  const savedChoice = saved.workspaceNetwork;
  // A stored trusted decision is only honored through its encrypted receipt:
  // an edited plaintext file, a forged receipt or a plaintext storage backend
  // confer no elevated trust.
  if (policy.normalize(savedChoice).policy === 'trusted_development') {
    try {
      const { safeStorage } = require('electron');
      if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') return policy.normalize();
      const receipt = JSON.parse(safeStorage.decryptString(Buffer.from(saved.workspaceNetworkReceipt, 'base64')));
      if ((receipt?.version === 2 || receipt?.version === 3) && receipt.policy === 'trusted_development') return policy.normalize(receipt);
    } catch {}
    return policy.normalize();
  }
  // A legacy explicit Isolated choice stays an explicit opt-out.
  if (savedChoice?.version === 2 && savedChoice.policy === 'isolated')
    return policy.normalize({ version: 3, policy: 'isolated' });
  return policy.normalize(savedChoice);
}
async function setWorkspaceNetwork(value) {
  const policy = require('./workspaceNetworkPolicy');
  const choice = policy.validate(value);
  const decisionRevision = ++networkDecisionRevision;
  if (choice.policy === 'trusted_development') {
    const ready = policy.readiness();
    if (!ready.available) throw Object.assign(new Error(ready.blockers.join(' ')), { code: ready.code });
    const { dialog, safeStorage } = require('electron');
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text')
      throw new Error('OS-protected settings storage is required for elevated networking.');
    const answer = await dialog.showMessageBox({ type: 'warning', title: 'Enable elevated networking?',
      message: 'Allow Workspace Write commands to reach host and private network services?',
      detail: policy.disclosureFor('trusted_development'),
      buttons: ['Cancel', 'Enable Elevated Networking'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1 || decisionRevision !== networkDecisionRevision) return getConfig();
    if (!policy.readiness().available) throw new Error('Networking readiness changed.');
  }
  const config = saveConfig({ workspaceNetwork: choice }, networkAuthority);
  networkAuthorizationRevision++;
  await require('./networkExecution').service.invalidateAll();
  return config;
}
function getWorkspaceNetworkStatus() {
  const policy = require('./workspaceNetworkPolicy');
  const readiness = policy.readiness();
  const effectivePolicy = getConfig().workspaceNetwork.policy;
  const { safeStorage } = require('electron');
  const protectedConsentAvailable = !!safeStorage?.isEncryptionAvailable?.() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  return { ...readiness, effectivePolicy, protectedConsentAvailable,
    consentRequired: effectivePolicy === 'trusted_development' && !protectedConsentAvailable,
    launchReady: readiness.available && protectedConsentAvailable && effectivePolicy === 'trusted_development',
    operational: readiness.available && effectivePolicy !== 'isolated' && require('./networkExecution').service.active() > 0,
    disclosure: policy.disclosureFor(effectivePolicy),
    runtimeVerification: 'Version/resource checks precede selection; owner startup verifies namespaces and effective cgroup limits.' };
}
function setModelDirectory(directory) {
  directory = fs.realpathSync(validatePath(directory));
  if (!fs.statSync(directory).isDirectory()) throw new Error('Choose a directory.');
  return saveConfig({ modelDirectory: directory }).modelDirectory;
}
module.exports = { networkRevision: () => networkAuthorizationRevision, getWorkspaceNetworkStatus, getConfig, saveConfig, setWorkspaceNetwork, setModelDirectory, validatePath };
