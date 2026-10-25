'use strict';
const SECRET_PREFIXES_RE = /\b(ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|gsk_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9\-_]{10,}|xox[a-z]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const URL_CREDS_RE = /(\bhttps?:\/\/)([^/\s:@]+):([^/\s@]+)@/g;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi;
// key\s*[:=]\s*value with quoted or bare keys/values (JSON, k=v, YAML-ish).
const LABELED_KV_RE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z0-9_.-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/g;

function isSecretName(rawKey) {
  const key = String(rawKey ?? '').replace(/^["']|["']$/g, '');
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) return false;
  const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const words = ['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'client_secret'];
  return words.some(
    (word) => snake === word || snake.endsWith(`_${word}`) || snake.endsWith(`-${word}`) || snake.endsWith(`.${word}`),
  );
}

function redactSecrets(text) {
  if (typeof text !== 'string') return '';
  return (
    text
      .replace(PRIVATE_KEY_RE, '[redacted private key]')
      .replace(URL_CREDS_RE, '$1[redacted]@')
      .replace(LABELED_KV_RE, (match, rawKey, sep, rawValue) => {
        if (!isSecretName(rawKey)) return match;
        const value = String(rawValue ?? '');
        const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
        return `${rawKey}${sep}${quote}[redacted]${quote}`;
      })
      .replace(SECRET_PREFIXES_RE, '[redacted]')
      .replace(BEARER_RE, 'bearer [redacted]')
      .replace(/\b(?=[A-Za-z0-9_+\/-]{48,}\b)(?=[A-Za-z0-9_+\/-]*[A-Za-z])(?=[A-Za-z0-9_+\/-]*[0-9])[A-Za-z0-9_+\/-]{48,}={0,2}/g, '[redacted token]')
  );
}


module.exports = { redactSecrets, isSecretName };
