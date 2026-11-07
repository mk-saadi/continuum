'use strict';
// Attachment identity/version records are independent of conversation grants.
// No filesystem path received from application web content is a read grant.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID, randomBytes, createHash, webcrypto } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const snapshots = new AsyncLocalStorage();
const bridges = new WeakMap();
const LIMIT = 20 * 1024 * 1024;
const db = () => require('./db').db;
const error = (code, name, detail) => Object.assign(new Error(`Attachment “${name}”: ${detail} Open attachment details to locate the file, accept its new version, use a saved copy, or omit it.`), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async bytes => Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
const identity = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
function directory() { return path.join(require('./configStore').getConfig().appDataDirectory, 'attachments'); }

function install(connection) {
  connection.exec(`CREATE TABLE IF NOT EXISTS attachment_assets(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS attachment_versions(
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES attachment_assets(id),
      storage_kind TEXT NOT NULL CHECK(storage_kind IN ('referenced','managed')),
      file_path TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL,
      size INTEGER, sha256 TEXT, stat_json TEXT, real_path TEXT,
      extracted_text TEXT, snapshot_path TEXT, legacy INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS attachment_path_aliases(asset_id TEXT NOT NULL, file_path TEXT NOT NULL, PRIMARY KEY(asset_id,file_path));
    CREATE TABLE IF NOT EXISTS attachment_drafts(
      token TEXT PRIMARY KEY, session_id TEXT NOT NULL, version_id TEXT NOT NULL REFERENCES attachment_versions(id));`);
  const columns = connection.pragma('table_info(message_attachments)');
  for (const [name, definition] of [['asset_id','TEXT'], ['version_id','TEXT'], ['omitted','INTEGER NOT NULL DEFAULT 0']])
    if (!columns.some(column => column.name === name)) connection.exec(`ALTER TABLE message_attachments ADD COLUMN ${name} ${definition}`);
  // Register old copies without reading/deleting/moving files or guessing sources.
  // Existing row IDs and opaque attachment_read_refs remain unchanged.
  const assets = connection.prepare('INSERT OR IGNORE INTO attachment_assets(id) VALUES (?)');
  const versions = connection.prepare(`INSERT OR IGNORE INTO attachment_versions(id,asset_id,storage_kind,file_path,name,mime_type,legacy) VALUES (?,?,'managed',?,?,?,1)`);
  const update = connection.prepare('UPDATE message_attachments SET asset_id=?,version_id=? WHERE id=?');
  connection.transaction(() => {
    for (const row of connection.prepare('SELECT * FROM message_attachments WHERE version_id IS NULL').all()) {
      const id = 'legacy_' + hash(Buffer.from(row.file_path));
      assets.run(id); versions.run(id,id,row.file_path,require('./fileUploads').attachmentName(row.file_path),row.mime_type);
      update.run(id,id,row.id);
    }
    connection.exec('INSERT OR IGNORE INTO attachment_path_aliases(asset_id,file_path) SELECT asset_id,file_path FROM attachment_versions');
    // Legacy path repair runs before this installer. Keep registered legacy
    // copies aligned while preserving their previous path aliases for briefs.
    for(const row of connection.prepare(`SELECT a.file_path,v.id FROM message_attachments a JOIN attachment_versions v ON v.id=a.version_id
      WHERE v.legacy=1 AND v.storage_kind='managed' AND a.file_path<>v.file_path`).all())
      connection.prepare('UPDATE attachment_versions SET file_path=?,real_path=NULL WHERE id=?').run(row.file_path,row.id);

  })();
}
function bridge(sender) {
  let token = bridges.get(sender);
  if (!token) { token = randomBytes(32).toString('hex'); bridges.set(sender,token); }
  return token;
}
function assertBridge(sender, token) {
  if (!sender || !bridges.has(sender) || token !== bridges.get(sender)) throw error('ATTACHMENT_UNAUTHORIZED','selection','Disk provenance must come from the isolated Electron file bridge.');
}
function checkSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.includes('\0')) throw new TypeError('An attachment conversation is required.');
  require('./sessionDeletion').assertAvailable(sessionId);
}
function safePath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0') || filePath.split(/[\\/]/).includes('..'))
    throw error('ATTACHMENT_UNAUTHORIZED','file','An absolute, non-traversing native-selected path is required.');
}
function checkManaged(filePath) {
  safePath(filePath);
  try {
    if (path.dirname(fs.realpathSync(filePath)) !== fs.realpathSync(directory()))
      throw error('ATTACHMENT_UNAUTHORIZED',path.basename(filePath),'The managed file is outside attachment storage.');
  } catch(cause) {
    if(cause.code?.startsWith('ATTACHMENT')) throw cause;
    throw error(cause.code==='ENOENT'?'ATTACHMENT_MISSING':'ATTACHMENT_UNREADABLE',path.basename(filePath),'The managed copy is missing or inaccessible.');
  }
}
async function capture(filePath, name = path.basename(filePath)) {
  safePath(filePath);
  let handle;
  try {
    if ((await fsp.lstat(filePath)).isSymbolicLink()) throw error('ATTACHMENT_CHANGED',name,'Symbolic-link sources are not accepted. Select the actual file.');
    const real = await fsp.realpath(filePath);
    handle = await fsp.open(filePath,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > LIMIT) throw error('ATTACHMENT_LIMIT',name,'Use a regular file of at most 20 MiB.');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes,offset,bytes.length-offset,offset); if (!bytesRead) break; offset += bytesRead; }
    const sha256 = await digest(bytes); // Thread-pool crypto, not a main-thread hash of a large selection.
    const after = await handle.stat(), atPath = await fsp.lstat(filePath);
    if (offset !== bytes.length || identity(before) !== identity(after) || identity(after) !== identity(atPath) || real !== await fsp.realpath(filePath))
      throw error('ATTACHMENT_CHANGED',name,'The file changed while it was being read. Retry after saving it.');
    return { bytes, sha256, size:bytes.length, stat_json:identity(after), real_path:real };
  } catch (cause) {
    if (cause.code?.startsWith('ATTACHMENT')) throw cause;
    throw error(cause.code === 'ENOENT' ? 'ATTACHMENT_MISSING' : 'ATTACHMENT_UNREADABLE',name,cause.code === 'ENOENT' ? 'The file is missing.' : 'The file cannot be safely read. Check access permissions and symlinks.');
  } finally { await handle?.close(); }
}
function version(id) { return db().prepare('SELECT * FROM attachment_versions WHERE id=?').get(id); }
function view(row) {
  const v = row.version_id ? version(row.version_id) : null;
  return v ? { ...row, asset_id:v.asset_id, version_id:v.id, file_path:v.file_path, name:v.name, mime_type:v.mime_type,
    size:v.size, storage_kind:v.storage_kind, fingerprint:v.sha256, has_copy:!!v.snapshot_path || v.storage_kind === 'managed' } : row;
}
function ownedRow(sessionId, attachmentId) {
  checkSession(sessionId);
  const row = db().prepare(`SELECT a.*,m.session_id FROM message_attachments a JOIN messages m ON m.id=a.message_id
    WHERE a.id=? AND m.session_id=? AND m.role='user'`).get(attachmentId,sessionId);
  if (!row) throw error('ATTACHMENT_UNAUTHORIZED','file','This attachment is not owned by this conversation.');
  return row;
}
function authorize(file, sessionId) {
  if (file?.draft_token) {
    checkSession(sessionId);
    const draft = db().prepare('SELECT * FROM attachment_drafts WHERE token=? AND session_id=?').get(file.draft_token,sessionId);
    if (!draft || draft.version_id !== file.version_id) throw error('ATTACHMENT_UNAUTHORIZED','draft','Invalid attachment draft grant.');
    return view({version_id:draft.version_id,draft_token:draft.token,session_id:sessionId});
  }
  if (file?.id && sessionId) return view(ownedRow(sessionId,file.id));
  // Authoritative main-process rows may be inspected without a caller session,
  // but must exactly match a persisted grant; renderer IPC always supplies one.
  if (file?.id && file?.message_id) {
    const row = db().prepare('SELECT * FROM message_attachments WHERE id=? AND message_id=?').get(file.id,file.message_id);
    if (row && row.version_id === file.version_id) return view(row);
  }
  throw error('ATTACHMENT_UNAUTHORIZED','file','Use a conversation attachment ID or an authorized draft, not a path.');
}
function verify(v, captured) {
  if (v.sha256 && (v.sha256 !== captured.sha256 || (v.storage_kind === 'referenced' && (v.stat_json !== captured.stat_json || v.real_path !== captured.real_path))))
    throw error('ATTACHMENT_CHANGED',v.name,'The source has changed or was replaced since it was attached. Nothing from the changed file was sent.');
  return captured;
}
async function verified(v) {
  if (v.storage_kind === 'managed') checkManaged(v.file_path);
  const data = verify(v,await capture(v.file_path,v.name));
  if (!v.sha256) {
    const extracted = await require('./attachmentDocuments').extractDocumentBytes(data.bytes,v.mime_type);
    db().prepare('UPDATE attachment_versions SET sha256=?,size=?,stat_json=?,real_path=?,extracted_text=? WHERE id=? AND sha256 IS NULL')
      .run(data.sha256,data.size,data.stat_json,data.real_path,extracted ?? null,v.id);
    v = version(v.id);
    verify(v,data); // A concurrent first read must not pair another version's text with these bytes.
  }
  return { ...data, extracted_text:v.extracted_text, version:v };
}
function readSnapshot(file) {
  const v = version(file.version_id);
  if (!v) throw error('ATTACHMENT_UNAVAILABLE',file.name || 'file','The source version is unavailable.');
  const cached = snapshots.getStore()?.get(v.id);
  if (cached) { if (cached.error) throw cached.error; return cached; }
  // Synchronous compatibility for internal source builders; interactive IPC
  // preloads snapshots asynchronously. Tools deliberately check current bytes.
  if (v.storage_kind === 'managed') checkManaged(v.file_path);
  let fd;
  try {
    safePath(v.file_path);
    const real = fs.realpathSync(v.file_path);
    fd = fs.openSync(v.file_path,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > LIMIT) throw error('ATTACHMENT_LIMIT',v.name,'Use a regular file of at most 20 MiB.');
    const bytes = Buffer.alloc(before.size); let n=0;
    while(n<bytes.length) { const count=fs.readSync(fd,bytes,n,bytes.length-n,n); if(!count) break; n+=count; }
    const after = fs.fstatSync(fd), atPath = fs.lstatSync(v.file_path);
    if (n !== bytes.length || identity(before)!==identity(after) || identity(after)!==identity(atPath) || real!==fs.realpathSync(v.file_path)) throw error('ATTACHMENT_CHANGED',v.name,'The source changed during reading.');
    const data=verify(v,{bytes,sha256:hash(bytes),size:bytes.length,stat_json:identity(after),real_path:real});
    if (!v.sha256 && !['application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(v.mime_type))
      db().prepare('UPDATE attachment_versions SET sha256=?,size=?,stat_json=?,real_path=? WHERE id=? AND sha256 IS NULL').run(data.sha256,data.size,data.stat_json,data.real_path,v.id);
    return {...data,extracted_text:v.extracted_text,version:v};
  } catch(cause) {
    if(cause.code?.startsWith('ATTACHMENT')) throw cause;
    throw error(cause.code==='ENOENT'?'ATTACHMENT_MISSING':'ATTACHMENT_UNREADABLE',v.name,'The attachment cannot be safely read.');
  } finally { if(fd!==undefined) fs.closeSync(fd); }
}
async function withSnapshots(sessionId, extras, action) {
  if (!sessionId || snapshots.getStore()) return action();
  checkSession(sessionId);
  const rows = db().prepare(`SELECT a.* FROM message_attachments a JOIN messages m ON m.id=a.message_id WHERE m.session_id=? AND a.omitted=0`).all(sessionId);
  const files = [...rows,...(extras || []).filter(file=>file.version_id).map(file=>authorize(file,sessionId))];
  const data = new Map();
  for (const file of files) {
    if (!file.version_id || data.has(file.version_id)) continue;
    try { data.set(file.version_id,await verified(version(file.version_id))); }
    catch(cause) { data.set(file.version_id,{error:cause}); }
  }
  checkSession(sessionId);
  return snapshots.run(data,action);
}
async function saveVersion({assetId=randomUUID(), filePath, mime, name, kind, data, legacy=0}) {
  if (mime.startsWith('image/')) await require('./imageAttachments').inspectImage(data.bytes,mime);
  const extracted = await require('./attachmentDocuments').extractDocumentBytes(data.bytes,mime);
  const id=randomUUID();
  db().transaction(()=>{
    db().prepare('INSERT OR IGNORE INTO attachment_assets(id) VALUES (?)').run(assetId);
    db().prepare(`INSERT INTO attachment_versions(id,asset_id,storage_kind,file_path,name,mime_type,size,sha256,stat_json,real_path,extracted_text,legacy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,assetId,kind,filePath,name,mime,data.size,data.sha256,data.stat_json,data.real_path,extracted??null,legacy);
    db().prepare('INSERT OR IGNORE INTO attachment_path_aliases(asset_id,file_path) VALUES (?,?)').run(assetId,filePath);
  })();
  return version(id);
}
async function managedBytes(name, bytes) {
  await fsp.mkdir(directory(),{recursive:true});
  const filePath=path.join(directory(),`${Date.now()}-${randomUUID()}-${path.basename(name)}`);
  await fsp.writeFile(filePath,bytes,{flag:'wx'});
  return filePath;
}
async function stage(files,{sessionId,keepCopy=false}={}) {
  checkSession(sessionId);
  if(!Array.isArray(files)||files.length>10) throw new Error('Choose at most 10 attachments.');
  const result=[], createdPaths=[], createdVersions=[], createdTokens=[]; let total=0;
  try {
  for(const input of files) {
    let filePath,name,mime,data,kind;
    if (typeof input?.nativePath === 'string') {
      // Callers are the authenticated preload bridge or a native main dialog.
      const inspected=require('./fileUploads').inspectFile(input.nativePath);
      filePath=inspected.file_path; name=path.basename(filePath); mime=inspected.mime_type;
      data=await capture(filePath,name); kind='referenced';
      if(keepCopy) { filePath=await managedBytes(name,data.bytes); createdPaths.push(filePath); kind='managed'; data=await capture(filePath,name); }
    } else {
      const match=typeof input?.dataUrl==='string' && /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.dataUrl);
      if(!match || input.dataUrl.length>Math.ceil(LIMIT/3)*4+32) throw new Error('Pathless content must contain original supported file bytes.');
      const bytes=Buffer.from(match[2],'base64');
      if(!bytes.length || bytes.length>LIMIT || bytes.toString('base64')!==match[2]) throw new Error('Invalid or oversized image attachment.');
      name=path.basename(input.name||'pasted-image'+(require('./imageAttachments').EXTENSIONS[match[1]] || ''));
      mime=require('./fileUploads').MIME_TYPES[path.extname(name).toLowerCase()];
      if(!mime || (match[1]!==mime && match[1]!=='application/octet-stream')) throw new Error('Attachment filename/MIME mismatch.');
      if(mime.startsWith('image/')) await require('./imageAttachments').inspectImage(bytes,mime);
      filePath=await managedBytes(name,bytes); createdPaths.push(filePath); data=await capture(filePath,name); kind='managed';
    }
    total+=data.size; if(total>50*1024*1024) throw new Error('Attachments must total 50 MiB or less.');
    const v=await saveVersion({filePath,mime,name,kind,data}); createdVersions.push(v);
    checkSession(sessionId);
    const token=randomBytes(32).toString('hex');
    db().prepare('INSERT INTO attachment_drafts(token,session_id,version_id) VALUES (?,?,?)').run(token,sessionId,v.id); createdTokens.push(token);
    result.push(view({version_id:v.id,draft_token:token,session_id:sessionId}));
  }
  return result;
  } catch(cause) {
    // Roll back only this failed selection. Never unlink a referenced source.
    db().transaction(()=>{
      for(const token of createdTokens) db().prepare('DELETE FROM attachment_drafts WHERE token=?').run(token);
      for(const v of createdVersions) {
        db().prepare('DELETE FROM attachment_versions WHERE id=?').run(v.id);
        db().prepare('DELETE FROM attachment_path_aliases WHERE asset_id=?').run(v.asset_id);
        db().prepare('DELETE FROM attachment_assets WHERE id=?').run(v.asset_id);
      }
    })();
    await Promise.all(createdPaths.map(file=>fsp.unlink(file).catch(()=>{})));
    throw cause;
  }
}
async function inspect(file,sessionId) {
  checkSession(sessionId);
  const row=authorize(file,sessionId);
  if(row.omitted) return {...row,status:'omitted'};
  try { await verified(version(row.version_id)); return {...view(row),status:'ready'}; }
  catch(cause) { return {...view(row),status:cause.code||'ATTACHMENT_UNREADABLE',problem:cause.message}; }
}
async function preview(file,sessionId) {
  checkSession(sessionId);
  const row=authorize(file,sessionId);
  if(row.omitted) throw error('ATTACHMENT_OMITTED',row.name,'This attachment was explicitly omitted.');
  const data=await verified(version(row.version_id));
  const stillOwned=authorize(file,sessionId);
  if(stillOwned.omitted || stillOwned.version_id!==row.version_id) throw error('ATTACHMENT_CHANGED',row.name,'The attachment grant changed during preview.');
  return { dataUrl:/^(image|video)\//.test(row.mime_type)?`data:${row.mime_type};base64,${data.bytes.toString('base64')}`:null };
}
async function recover(file,sessionId,action,selectedPath) {
  checkSession(sessionId);
  let row=authorize(file,sessionId); const old=version(row.version_id);
  if(require('./engineManager').activeStreams.has(sessionId)) throw new Error('Stop the active run before changing attachments.');
  if(action==='omit'||action==='restore') {
    if(row.draft_token) { if(action==='omit') db().prepare('DELETE FROM attachment_drafts WHERE token=?').run(row.draft_token); return null; }
    db().prepare('UPDATE message_attachments SET omitted=? WHERE id=?').run(action==='omit'?1:0,row.id);
    require('./promptMeasurement').invalidateMeasuredContext(sessionId);
    return inspect({id:row.id},sessionId);
  }
  let v=old;
  if(action==='copy'||action==='use-copy') {
    let bytes;
    if(action==='use-copy') {
      if(!old.snapshot_path) throw new Error('No durable copy exists for this version.');
      checkManaged(old.snapshot_path);
      const snapshot=await capture(old.snapshot_path,old.name);
      if(snapshot.sha256!==old.sha256) throw error('ATTACHMENT_CHANGED',old.name,'The durable copy no longer matches this version.');
      bytes=snapshot.bytes;
    } else bytes=(await verified(old)).bytes;
    const filePath=action==='use-copy'?old.snapshot_path:await managedBytes(old.name,bytes);
    const data=await capture(filePath,old.name);
    v=await saveVersion({assetId:old.asset_id,filePath,mime:old.mime_type,name:old.name,kind:'managed',data});
    db().prepare('UPDATE attachment_versions SET snapshot_path=? WHERE id=?').run(filePath,old.id);
  } else if(action==='accept'||action==='locate'||action==='replace') {
    const filePath=action==='locate'||action==='replace'?selectedPath:old.file_path;
    if(action==='accept' && old.storage_kind!=='referenced') throw new Error('Only referenced sources can accept a changed version.');
    if(action==='locate' && !old.sha256) throw error('ATTACHMENT_CHANGED',old.name,'This legacy copy has no recorded fingerprint to verify a matching file. Use “Choose new version” to approve a replacement explicitly.');
    const inspected=require('./fileUploads').inspectFile(filePath);
    if(inspected.mime_type!==old.mime_type) throw new Error('Locate a file with the same attachment format.');
    const data=await capture(filePath,old.name);
    if(action==='locate' && old.sha256 && data.sha256!==old.sha256) throw error('ATTACHMENT_CHANGED',old.name,'The selected file has different content. Locate the matching file, or accept the changed source explicitly.');
    v=await saveVersion({assetId:old.asset_id,filePath,mime:old.mime_type,name:old.name,kind:'referenced',data});
  } else throw new Error('Invalid attachment recovery action.');
  checkSession(sessionId);
  // Recheck grants after asynchronous work; never revive a revoked reference.
  row=authorize(file,sessionId);
  if(row.version_id!==old.id) throw new Error('Attachment changed during recovery. Refresh its details and retry.');
  if(row.draft_token) db().prepare('UPDATE attachment_drafts SET version_id=? WHERE token=?').run(v.id,row.draft_token);
  else db().prepare('UPDATE message_attachments SET version_id=?,asset_id=?,file_path=?,omitted=? WHERE id=?').run(v.id,v.asset_id,v.file_path,row.omitted || 0,row.id);
  require('./promptMeasurement').invalidateMeasuredContext(sessionId);
  return view({...row,version_id:v.id});
}
function rowForFile(file, messageId) {
  if(!Number.isInteger(messageId)) return null;
  if(file.id) {
    const exact=db().prepare('SELECT * FROM message_attachments WHERE id=? AND message_id=?').get(file.id,messageId);
    if(exact)return exact;
  }
  if(file.asset_id) return db().prepare('SELECT * FROM message_attachments WHERE message_id=? AND asset_id=? ORDER BY id LIMIT 1').get(messageId,file.asset_id);
  return db().prepare(`SELECT a.* FROM message_attachments a WHERE a.message_id=? AND
    (a.file_path=? OR EXISTS(SELECT 1 FROM attachment_versions v WHERE v.asset_id=a.asset_id AND v.file_path=?) OR EXISTS(SELECT 1 FROM attachment_path_aliases p WHERE p.asset_id=a.asset_id AND p.file_path=?)) ORDER BY a.id LIMIT 1`).get(messageId,file.file_path,file.file_path,file.file_path);
}
async function requestSnapshot(file) {
  const cached=snapshots.getStore()?.get(file.version_id);
  if(cached) { if(cached.error) throw cached.error; return cached; }
  return verified(version(file.version_id));
}
function freshSnapshot(file) { return snapshots.exit(()=>readSnapshot(file)); }
module.exports={checkSession,requestSnapshot,freshSnapshot,install,bridge,assertBridge,stage,version,view,ownedRow,authorize,readSnapshot,verified,withSnapshots,inspect,preview,recover,rowForFile,capture,directory};
