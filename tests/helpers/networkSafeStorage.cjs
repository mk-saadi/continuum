// Test-only OS key-store stand-in. Never imported by application code.
const crypto = require('node:crypto');
const key = crypto.randomBytes(32);
module.exports = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'test',
  encryptString(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
  },
  decryptString(value) {
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString();
  },
};
