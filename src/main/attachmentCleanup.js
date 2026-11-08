'use strict';
// Only creation receipts confer permission to unlink. Legacy paths are not receipts.
const fs = require('node:fs');
const path = require('node:path');
const epoch=require('node:crypto').randomUUID();
let active = 0, running = false, timer;
const db = () => require('./db').db;
const key = s => JSON.stringify([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]);
function install(connection) {
  connection.exec(`CREATE TABLE IF NOT EXISTS attachment_cleanup_files(
    file_path TEXT PRIMARY KEY, root_path TEXT NOT NULL, root_identity TEXT NOT NULL,
    identity TEXT NOT NULL, bytes INTEGER NOT NULL, fingerprint TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, failure TEXT);
    CREATE TABLE IF NOT EXISTS attachment_cleanup_stats(id INTEGER PRIMARY KEY CHECK(id=1), reclaimed INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO attachment_cleanup_stats(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS attachment_draft_lifetimes(token TEXT PRIMARY KEY, epoch TEXT NOT NULL);`);
  // Renderer selections do not survive a process restart. Older, unclassified drafts
  // remain protected rather than inferring that they were abandoned.
  connection.prepare('DELETE FROM attachment_drafts WHERE token IN (SELECT token FROM attachment_draft_lifetimes WHERE epoch<>?)').run(epoch);
  connection.prepare('DELETE FROM attachment_draft_lifetimes WHERE epoch<>?').run(epoch);
  clearInterval(timer);
  timer = setInterval(()=>run().catch(()=>{}),30000); timer.unref();
}
function receipt(file, fingerprint, expectedStat) {
  const root = path.dirname(file), canonical = fs.realpathSync(root);
  if(root !== canonical || fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe managed storage root');
  const s=fs.lstatSync(file), r=fs.statSync(root);
  if(!expectedStat || key(s)!==key(expectedStat)) throw new Error('Managed creation descriptor no longer matches path');
  db().prepare(`INSERT INTO attachment_cleanup_files(file_path,root_path,root_identity,identity,bytes,fingerprint) VALUES(?,?,?,?,?,?)`)
    .run(file,root,JSON.stringify([r.dev,r.ino]),key(s),s.size,fingerprint);
}
function refreshReceipt(file, stat, fingerprint) {
  const current=fs.lstatSync(file);
  if(key(current)!==key(stat)||current.isSymbolicLink()) throw new Error('Managed file changed during creation');
  db().prepare('UPDATE attachment_cleanup_files SET identity=?,bytes=?,fingerprint=? WHERE file_path=?')
    .run(key(stat),stat.size,fingerprint,file);
}
async function hold(action) { active++; try { return await action(); } finally { active--; } }
function retained() {
  const versions=db().prepare('SELECT * FROM attachment_versions').all();
  const ids=new Set(db().prepare('SELECT version_id FROM message_attachments UNION SELECT version_id FROM attachment_drafts').all().map(r=>r.version_id));
  const assets=new Set(), paths=new Set(); let uncertain=false;
  for(const row of db().prepare('SELECT attachments_json FROM workspace_task_briefs').all()) {
    try { for(const f of JSON.parse(row.attachments_json)) { if(f.version_id) ids.add(f.version_id); if(f.asset_id) assets.add(f.asset_id); if(f.file_path) paths.add(f.file_path); } }
    catch { uncertain=true; }
  }
  for(const alias of db().prepare('SELECT * FROM attachment_path_aliases').all()) if(paths.has(alias.file_path)) assets.add(alias.asset_id);
  for(const v of versions) if(ids.has(v.id)||assets.has(v.asset_id)||uncertain) {
    ids.add(v.id); paths.add(v.file_path); if(v.snapshot_path) paths.add(v.snapshot_path);
  }
  // Unversioned legacy ownership rows can share a physical file.
  for(const r of db().prepare('SELECT file_path FROM message_attachments').all()) paths.add(r.file_path);
  // Legacy records without reconstructable ownership stay as evidence. Resolve
  // aliases only to retain data; canonicalization never authorizes deletion.
  for(const v of versions) if(v.legacy) {paths.add(v.file_path);if(v.snapshot_path)paths.add(v.snapshot_path);}
  for(const file of [...paths]) paths.add(file+'.extracted.txt');
  for(const file of [...paths]) {try {paths.add(fs.realpathSync(file));}catch {}}
  return {versions,ids,paths};
}
function status() {
  const live=retained(), receipts=db().prepare('SELECT * FROM attachment_cleanup_files').all();
  const known=new Set(receipts.map(r=>r.file_path));
  const unresolved=new Set(live.versions.filter(v=>v.storage_kind==='managed'&&!known.has(v.file_path)).map(v=>v.file_path));
  try {
    const root=require('./attachmentStore').directory();
    if(fs.realpathSync(root)===root) for(const name of fs.readdirSync(root)) {
      const file=path.join(root,name); if(!known.has(file)) unresolved.add(file);
    }
  } catch { /* Missing/unreadable roots do not confer deletion authority. */ }

  return {reclaimedBytes:db().prepare('SELECT reclaimed FROM attachment_cleanup_stats WHERE id=1').get().reclaimed,
    pendingFiles:receipts.filter(r=>!live.paths.has(r.file_path)).length,
    retryableFailures:receipts.filter(r=>r.failure).length,
    unusedVersions:live.versions.filter(v=>!live.ids.has(v.id)).length,
    unresolvedLegacyItems:unresolved.size,
    activeOperations:active};
}
async function run({dryRun=false,limit=16}={}) {
  if(dryRun) return status();
  if(running || active || require('./dataAccess').isMigrating()) return status();
  running=true;
  try {
    const livePaths=retained().paths;
    const candidates=db().prepare('SELECT * FROM attachment_cleanup_files ORDER BY attempts, file_path').all().filter(r=>!livePaths.has(r.file_path));
    let count=0;
    for(const r of candidates) {
      if(count++>=Math.max(1,Math.min(64,limit))) break;
      await new Promise(resolve=>setImmediate(resolve));
      if(active || require('./dataAccess').isMigrating()) break;
      // No await between final ownership/identity checks and unlink. Transactions
      // make a crash after unlink recoverable: the receipt remains for ENOENT retry.
      db().transaction(()=>{
        if(retained().paths.has(r.file_path)) return;
        try {
          if(r.root_path!==require('./attachmentStore').directory() || path.dirname(r.file_path)!==r.root_path || fs.realpathSync(r.root_path)!==r.root_path ||
            JSON.stringify([fs.statSync(r.root_path).dev,fs.statSync(r.root_path).ino])!==r.root_identity)
            throw Object.assign(new Error(),{code:'UNSAFE_ROOT'});
          // Anchor unlink to an opened directory, so replacing any ancestor
          // after validation cannot redirect it into an external original.
          if(process.platform!=='linux') throw Object.assign(new Error(),{code:'SAFE_UNLINK_UNAVAILABLE'});
          const fd=fs.openSync(r.root_path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
          let s;
          try {
          const rootStat=fs.fstatSync(fd);
          if(JSON.stringify([rootStat.dev,rootStat.ino])!==r.root_identity) throw Object.assign(new Error(),{code:'REPLACED_ROOT'});
          const anchored='/proc/self/fd/'+fd+'/'+path.basename(r.file_path);
          try { s=fs.lstatSync(anchored); } catch(e) { if(e.code!=='ENOENT') throw e; }
          if(s) {
            if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(anchored)!==r.file_path||key(s)!==r.identity)
              throw Object.assign(new Error(),{code:'REPLACED_PATH'});
            fs.unlinkSync(anchored);
          }
          } finally { fs.closeSync(fd); }
          db().prepare('DELETE FROM attachment_cleanup_files WHERE file_path=?').run(r.file_path);
          db().prepare('UPDATE attachment_cleanup_stats SET reclaimed=reclaimed+? WHERE id=1').run(s ? r.bytes : 0);
        } catch(e) { db().prepare('UPDATE attachment_cleanup_files SET failure=?,attempts=attempts+1 WHERE file_path=?').run(e.code||'IO_ERROR',r.file_path); }
      })();
    }
    if(!active && !require('./dataAccess').isMigrating()) db().transaction(()=>{
      db().prepare('DELETE FROM attachment_draft_lifetimes WHERE token NOT IN (SELECT token FROM attachment_drafts)').run();
      const live=retained();
      for(const v of live.versions.filter(v=>!v.legacy&&!live.ids.has(v.id)).slice(0,64)) {
        // Keep unknown legacy records as evidence; never turn them into guessed orphans.
        if(v.legacy) continue;
        db().prepare('DELETE FROM document_chunks WHERE file_path=?').run('attachment-version:'+v.id);
        db().prepare('DELETE FROM attachment_versions WHERE id=?').run(v.id);
      }
    })();
    return status();
  } finally { running=false; }
}
module.exports={epoch,install,receipt,refreshReceipt,hold,retained,status,run};
