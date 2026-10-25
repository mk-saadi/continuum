'use strict';
const SECRET_PREFIXES_RE = /\b(ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|gsk_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9\-_]{10,}|xox[a-z]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const URL_CREDS_RE = /(\bhttps?:\/\/)([^/\s:@]+):([^/\s@]+)@/g;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi;
// key\s*[:=]\s*value with quoted or bare keys/values (JSON, k=v, YAML-ish).
const LABELED_KV_RE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z0-9_.-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/g;

const LONG_TOKEN_RE = /\b(?=[A-Za-z0-9_+\/-]{48,}\b)(?=[A-Za-z0-9_+\/-]*[A-Za-z])(?=[A-Za-z0-9_+\/-]*[0-9])[A-Za-z0-9_+\/-]{48,}={0,2}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const AUTHORIZATION_RE = /(\bAuthorization\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi;
const SPAN_CHAR_RE = /[^\s"'`()\[\]{},]/;
const PATH_RE = /^(?:\/|\.\/|\.\.\/|~\/)?[A-Za-z0-9._~@%+,-]+(?:\/[A-Za-z0-9._~@%+,-]+)*\/?$/;
const MIXED_SEGMENT_RE = /^(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{32,}$/;

function pathContext(source, offset, length, workspaceRoot) {
  // A configured root can include whitespace, unlike ordinary lexical spans.
  const root = typeof workspaceRoot === 'string' ? workspaceRoot.replace(/\/+$/, '') : '';
  if (root) {
    const start = source.lastIndexOf(root, offset);
    if (start >= 0 && (start === 0 || !SPAN_CHAR_RE.test(source[start - 1]) || source[start - 1] === '=') &&
        (source[start + root.length] === '/' || !source[start + root.length] || !SPAN_CHAR_RE.test(source[start + root.length]) ||
          /^:\d+(?::\d+)?(?=$|[\s"'`()\[\]{},])/.test(source.slice(start + root.length)))) {
      let end = start + root.length;
      while (end < source.length && SPAN_CHAR_RE.test(source[end])) end++;
      if (offset >= start && offset + length <= end) return { path: true, automatic: true };
    }
  }
  let start = offset, end = offset + length;
  while (start > 0 && SPAN_CHAR_RE.test(source[start - 1])) start--;
  while (end < source.length && SPAN_CHAR_RE.test(source[end])) end++;
  // Assignment syntax belongs to the surrounding output, not the path value.
  const span = source.slice(start, end).replace(/^[^=]*=(?=.)/, '').replace(/:\d+(?::\d+)?$/, '');
  const automatic = /^(?:\/|\.\/|\.\.\/|~\/)/.test(span);
  return { path: (span === '/' || PATH_RE.test(span)) && (automatic || (span.includes('/') && !span.includes('+'))), automatic };
}

function redactGenericTokens(text, { workspaceRoot } = {}) {
  // Bare relative paths get segment-level filtering even below the generic
  // 48-character threshold. Explicitly rooted paths are exempt from this rule.
  text = text.replace(LONG_TOKEN_RE, (match, offset, source) =>
    pathContext(source, offset, match.length, workspaceRoot).path ? match : '[redacted token]');
  return text.replace(/[A-Za-z0-9]{32,}/g, (segment, offset, source) => {
    if (/[A-Za-z0-9._~@%+,-]/.test(source[offset - 1] ?? '') ||
        /[A-Za-z0-9._~@%+,-]/.test(source[offset + segment.length] ?? '')) return segment;
    const context = pathContext(source, offset, segment.length, workspaceRoot);
    return context.path && !context.automatic && MIXED_SEGMENT_RE.test(segment)
      ? '[redacted token]' : segment;
  });
}

function isSecretName(rawKey) {
  const key = String(rawKey ?? '').replace(/^["']|["']$/g, '');
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) return false;
  const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const words = ['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'client_secret'];
  return words.some(
    (word) => snake === word || snake.endsWith(`_${word}`) || snake.endsWith(`-${word}`) || snake.endsWith(`.${word}`),
  );
}

function redactSecrets(text, options = {}) {
  if (typeof text !== 'string') return '';
  return redactGenericTokens(
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
      .replace(JWT_RE, '[redacted]')
      .replace(AUTHORIZATION_RE, (_match, prefix) => `${prefix}[redacted]`),
    options,
  );
}


module.exports = { redactSecrets, isSecretName };
