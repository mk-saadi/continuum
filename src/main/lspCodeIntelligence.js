'use strict';
// Internal only: contexts must be owned by the main process, never renderer input.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { manager: defaultManager } = require('./lspManager');
const error = code => Object.assign(new Error(code), { code });
const range = r => {
  if (!r || ![r.start, r.end].every(p => Number.isInteger(p?.line) && p.line >= 0 && Number.isInteger(p?.character) && p.character >= 0)) throw error('INVALID_RESPONSE');
  return { startLine: r.start.line + 1, startColumn: r.start.character + 1, endLine: r.end.line + 1, endColumn: r.end.character + 1 };
};
const codes = { WORKSPACE_UNAUTHORIZED: 'PERMISSION_DENIED', ENOENT: 'FILE_NOT_FOUND', UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_LANGUAGE', UNSUPPORTED_CAPABILITY: 'CAPABILITY_UNAVAILABLE', REQUEST_TIMEOUT: 'TIMEOUT', REQUEST_CANCELLED: 'CANCELLED', STALE_DOCUMENT: 'STALE_RESULT', SERVER_TERMINATED: 'SERVER_UNAVAILABLE', INITIALIZATION_FAILED: 'SERVER_UNAVAILABLE' };
class LspCodeIntelligence {
  constructor(manager = defaultManager, { ttl = 60000, maxSnapshots = 16, maxResults = 2000, maxBytes = 4 * 1024 * 1024, now = Date.now } = {}) {
    Object.assign(this, { manager, ttl, maxSnapshots, maxResults, maxBytes, now }); this.snapshots = new Map();
  }
  prune() { for (const [key, s] of this.snapshots) if (s.expires <= this.now() || s.entry.state !== 'ready') this.snapshots.delete(key); }
  get snapshotBytes() { return [...this.snapshots.values()].reduce((n, s) => n + s.bytes, 0); }
  async location(entry, location) {
    try {
      const uri = location.targetUri ?? location.uri;
      if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
      const f = await this.manager.file(entry, uri);
      return { path: path.relative(entry.root, f.target).split(path.sep).join('/'), ...range(location.targetSelectionRange ?? location.range ?? location.targetRange) };
    } catch (e) { if (e.code === 'WORKSPACE_UNAUTHORIZED' || e.code === 'ENOENT') return null; throw e; }
  }
  page(s, offset, size, key) {
    const results = s.results.slice(offset, offset + size); const more = offset + results.length < s.results.length;
    let nextCursor;
    if (more) { nextCursor = randomUUID(); s.cursors.set(nextCursor, offset + results.length); }
    return { success: true, ...s.meta, results, returnedCount: results.length, totalCount: s.results.length, hasMore: more, ...(nextCursor ? { nextCursor } : {}), truncated: s.truncated, applicationTruncated: s.truncated, serverTruncated: 'unknown', incomplete: s.truncated ? true : 'unknown', snapshotId: key, provenance: 'immutable-query-snapshot', observedAt: s.observedAt };
  }
  store(entry, op, results, meta, size, truncated = false) {
    this.prune(); const key = randomUUID();
    const bounded = []; let bytes = 0;
    for (const item of results) { const n = Buffer.byteLength(JSON.stringify(item)); if (bounded.length >= this.maxResults || bytes + n > this.maxBytes / 2) { truncated = true; break; } bounded.push(item); bytes += n; }
    const s = { entry, op, results: bounded, meta, bytes, cursors: new Map(), expires: this.now() + this.ttl, observedAt: new Date(this.now()).toISOString(), truncated };
    while (this.snapshots.size && (this.snapshots.size >= this.maxSnapshots || this.snapshotBytes + bytes > this.maxBytes)) this.snapshots.delete(this.snapshots.keys().next().value);
    this.snapshots.set(key, s); return this.page(s, 0, size, key);
  }
  async run(op, input = {}) {
    try {
      if (!input || typeof input !== 'object') throw error('INVALID_REQUEST');
      const { executionContext: context, signal } = input;
      const size = input.pageSize ?? 25;
      if (!Number.isInteger(size) || size < 1 || size > 100) throw error('INVALID_REQUEST');
      if (signal?.aborted) throw error('REQUEST_CANCELLED');
      if (input.timeout !== undefined && (!Number.isInteger(input.timeout) || input.timeout < 1 || input.timeout > 30000)) throw error('INVALID_REQUEST');
      const root = await this.manager.identity(context);
      if (input.cursor !== undefined) {
        // Check expiry separately so expired opaque cursors have a useful category.
        for (const [key, s] of this.snapshots) {
          if (!s.cursors.has(input.cursor)) continue;
          if (s.entry.root !== root || s.op !== op) throw error('INVALID_CURSOR');
          if (s.expires <= this.now() || this.manager.instances.get(root) !== s.entry || s.entry.state !== 'ready') { this.snapshots.delete(key); throw error('STALE_CURSOR'); }
          await this.manager.check(context, s.entry);
          // One-use cursor bounds cursor memory as well as snapshot memory.
          const offset = s.cursors.get(input.cursor); s.cursors.delete(input.cursor);
          return this.page(s, offset, size, key);
        }
        throw error('INVALID_CURSOR');
      }
      if (op !== 'workspaceSymbols' && (typeof input.filePath !== 'string' || path.isAbsolute(input.filePath) || /^[a-zA-Z]:|^file:|^\\/.test(input.filePath))) throw error('INVALID_FILE');
      if (op === 'workspaceSymbols' && (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 256 || /[\x00-\x1f]/.test(input.query))) throw error('INVALID_QUERY');
      if (['definition', 'references', 'hover'].includes(op) && (!Number.isInteger(input.line) || !Number.isInteger(input.column) || input.line < 1 || input.column < 1)) throw error('INVALID_POSITION');
      if (op === 'diagnostics') return await this.diagnosticResult(input, root, size);
      const methods = { definition: 'textDocument/definition', references: 'textDocument/references', documentSymbols: 'textDocument/documentSymbol', workspaceSymbols: 'workspace/symbol', hover: 'textDocument/hover' };
      if (!methods[op]) throw error('INVALID_REQUEST');
      return await this.manager.request(context, methods[op], { path: input.filePath, position: { line: input.line - 1, character: input.column - 1 }, includeDeclaration: input.includeDeclaration, query: input.query }, {
        signal, timeout: input.timeout,
        transform: async (raw, entry, params) => {
          const doc = entry.documents.get(params.textDocument?.uri);
          const meta = { ...(doc ? { file: path.relative(root, require('node:url').fileURLToPath(doc.uri)).split(path.sep).join('/'), sourceVersion: doc.hash } : {}), positionEncoding: 'utf-16' };
          if (op === 'hover') {
            const limit = input.maxCharacters ?? 6000;
            if (!Number.isInteger(limit) || limit < 1 || limit > 24000) throw error('INVALID_REQUEST');
            const content = v => typeof v === 'string' ? v : v?.language ? '```' + String(v.language).slice(0, 80) + '\n' + String(v.value ?? '') + '\n```' : String(v?.value ?? '');
            const text = (Array.isArray(raw?.contents) ? raw.contents : [raw?.contents]).filter(v => v != null).map(content).join('\n\n');
            return { success: true, ...meta, content: text.slice(0, limit), format: raw?.contents?.kind === 'plaintext' ? 'plaintext' : 'markdown', untrusted: true, truncated: text.length > limit, ...(raw?.range ? { range: range(raw.range) } : {}) };
          }
          let excludedCount = 0; let normalizationTruncated = false; const results = [];
          const add = async (value, extra = {}) => { const loc = await this.location(entry, value); if (!loc) { excludedCount++; return; } results.push({ ...loc, ...extra }); };
          if (op === 'documentSymbols') {
            const walk = async (nodes, parentId = null, depth = 0) => {
              if (depth > 64) { normalizationTruncated = true; return; }
              for (const s of nodes) {
                if (results.length >= this.maxResults) { normalizationTruncated = true; break; }
                const id = String(results.length);
                await add(s.location ?? { uri: doc.uri, range: s.range }, { id, parentId, depth, name: String(s.name).slice(0, 512), kind: s.kind, ...(s.containerName ? { container: String(s.containerName).slice(0, 512) } : {}), ...(s.selectionRange ? { selection: range(s.selectionRange) } : {}) });
                if (Array.isArray(s.children)) await walk(s.children, id, depth + 1);
              }
            }; await walk(raw ?? []);
          } else for (const s of raw == null ? [] : Array.isArray(raw) ? raw : [raw]) {
            if (results.length >= this.maxResults) { normalizationTruncated = true; break; }
            await add(op === 'workspaceSymbols' ? s.location : s, op === 'workspaceSymbols' ? { name: String(s.name).slice(0, 512), kind: s.kind, ...(s.containerName ? { container: String(s.containerName).slice(0, 512) } : {}) } : {});
          }
          const unique = op === 'documentSymbols' ? results : [...new Map(results.map(v => [JSON.stringify(v), v])).values()].sort((a, b) => a.path.localeCompare(b.path, 'en') || a.startLine - b.startLine || a.startColumn - b.startColumn || JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
          return this.store(entry, op, unique, { ...meta, excludedCount, serverCompleteness: 'final-response-no-partial-results-requested' }, size, normalizationTruncated);
        }
      });
    } catch (e) { return { success: false, ...(op === 'diagnostics' && ['SERVER_UNAVAILABLE', 'SERVER_TERMINATED', 'INITIALIZATION_FAILED', 'UNSUPPORTED_CAPABILITY'].includes(e.code) ? { state: 'unavailable' } : {}), error: { code: `LSP_${codes[e.code] ?? (typeof e.code === 'string' ? e.code : 'SERVER_UNAVAILABLE')}` } }; }
  }
  async diagnosticResult(input, root, size) {
    const e = await this.manager.acquire(input.executionContext, input.signal);
    return this.manager.serialized(e, async () => {
      await this.manager.check(input.executionContext, e);
      const doc = await this.manager.sync(e, input.filePath); const publication = e.diagnostics.get(doc.uri);
      let state = !publication ? 'pending' : publication.stale ? 'stale' : 'ready';
      if (e.state !== 'ready') state = 'unavailable';
      if (input.severities !== undefined && (!Array.isArray(input.severities) || input.severities.some(v => ![1, 2, 3, 4].includes(v)))) throw error('INVALID_REQUEST');
      const results = []; let excludedCount = 0;
      for (const d of publication?.diagnostics ?? []) {
        if (input.severities && !input.severities.includes(d.severity)) continue;
        const related = [];
        for (const info of (d.relatedInformation ?? []).slice(0, 10)) { const loc = await this.location(e, info.location); if (loc) related.push({ ...loc, message: String(info.message).slice(0, 1000) }); else excludedCount++; }
        results.push({ ...range(d.range), severity: d.severity, code: typeof d.code === 'object' ? undefined : d.code, source: String(d.source ?? '').slice(0, 100), message: String(d.message).slice(0, 2000), messageTruncated: d.messageTruncated === true || String(d.message).length > 2000, ...(d.tags ? { tags: d.tags.filter(v => [1, 2].includes(v)) } : {}), ...(related.length ? { related } : {}) });
      }
      await this.manager.check(input.executionContext, e);
      if (input.signal?.aborted) throw error('REQUEST_CANCELLED');
      return this.store(e, 'diagnostics', [...new Map(results.map(d => [JSON.stringify(d), d])).values()], { state, file: input.filePath, sourceVersion: doc.hash, diagnosticVersion: publication?.version ?? null, excludedCount, positionEncoding: 'utf-16' }, size, (publication?.total ?? 0) > (publication?.diagnostics.length ?? 0));
    });
  }
  definition(input) { return this.run('definition', input); }
  references(input) { return this.run('references', input); }
  documentSymbols(input) { return this.run('documentSymbols', input); }
  workspaceSymbols(input) { return this.run('workspaceSymbols', input); }
  hover(input) { return this.run('hover', input); }
  diagnostics(input) { return this.run('diagnostics', input); }
}
module.exports = { LspCodeIntelligence, codeIntelligence: new LspCodeIntelligence() };
