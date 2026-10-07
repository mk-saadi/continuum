'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

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
    engineIdleTimeoutMinutes: validateIdleTimeout(saved.engineIdleTimeoutMinutes ?? -1),
    modelDirectory: validatePath(saved.modelDirectory ?? path.join(require('node:os').homedir(), 'Desktop', 'LLM_Models')),
    appDataDirectory: validatePath(saved.appDataDirectory ?? (legacy ? root : path.join(root, 'App_Data'))),
  };
}
function saveConfig(patch) {
  const config = { ...getConfig(), ...patch };
  validateIdleTimeout(config.engineIdleTimeoutMinutes);
  for (const key of ['modelDirectory', 'appDataDirectory']) config[key] = validatePath(config[key]);
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  const temporary = configFile() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, configFile());
  return config;
}
function setModelDirectory(directory) {
  directory = fs.realpathSync(validatePath(directory));
  if (!fs.statSync(directory).isDirectory()) throw new Error('Choose a directory.');
  return saveConfig({ modelDirectory: directory }).modelDirectory;
}
module.exports = { getConfig, saveConfig, setModelDirectory, validatePath };
