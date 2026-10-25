'use strict';
const { execFileSync } = require('node:child_process');
let hostIdentity = Object.freeze({ name: '', email: '' });
function validateIdentity(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Git identity must contain a name and email.');
  return Object.fromEntries(['name', 'email'].map(key => {
    const text = value[key] ?? '';
    if (typeof text !== 'string' || text.length > 320 || /[\x00-\x1f\x7f<>]/.test(text)) throw new Error(`Invalid Git ${key}: use a single line without angle brackets (maximum 320 characters).`);
    return [key, text.trim()];
  }));
}
function configValue(scope, key, { cwd, env = process.env } = {}) {
  // Read config in the main process. Ambient GIT_* overrides must not turn a
  // repository-local lookup into a different config source or identity.
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));
  try {
    const value = execFileSync('git', ['config', scope, '--null', '--get', `user.${key}`], {
      cwd, env: cleanEnv, encoding: 'utf8', timeout: 3000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\0$/, '');
    return validateIdentity({ [key]: value })[key];
  } catch (error) {
    if (error.status === 1 || (scope === '--local' && error.status === 128)) return '';
    if (error.code === 'ENOENT') return '';
    throw new Error(`Cannot read ${scope === '--local' ? 'repository' : 'global'} Git ${key}: ${error.message}`);
  }
}
// Called once during application launch; subsequent global edits apply on restart.
function initializeHostGitIdentity({ env = process.env } = {}) {
  hostIdentity = Object.freeze(Object.fromEntries(['name', 'email'].map(key => [key, configValue('--global', key, { env })])));
  return hostIdentity;
}
function identityEnvironment(root, { required = false, appIdentity = require('./configStore').getConfig().gitIdentity } = {}) {
  const app = validateIdentity(appIdentity);
  const identity = Object.fromEntries(['name', 'email'].map(key => [key, configValue('--local', key, { cwd: root }) || app[key] || hostIdentity[key]]));
  if (required && (!identity.name || !identity.email)) throw new Error('Git identity is missing. Set user.name and user.email in this repository, or add your Git identity in Settings → Agents & Skills, or configure global Git identity and restart Continuum.');
  return Object.fromEntries(['AUTHOR', 'COMMITTER'].flatMap(role => ['name', 'email'].filter(key => identity[key]).map(key => [`GIT_${role}_${key.toUpperCase()}`, identity[key]])));
}
module.exports = { validateIdentity, initializeHostGitIdentity, identityEnvironment };
