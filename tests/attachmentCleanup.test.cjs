'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cleanup-fixture-')),load=Module._load;
Module._load=function(name,...args){if(name==='electron')return {app:{isReady:()=>true,getPath:()=>root}};return load.call(this,name,...args);};
const database=require('../src/main/db');database.initDatabase();
const store=require('../src/main/attachmentStore'),cleanup=require('../src/main/attachmentCleanup');
const stage=async()=> (await store.stage([{name:'fixture.txt',dataUrl:'data:text/plain;base64,aGVsbG8='}],{sessionId:'draft'}))[0];
const remove=f=>database.db.prepare('DELETE FROM attachment_drafts WHERE token=?').run(f.draft_token);
test.after(()=>{database.closeDatabase();Module._load=load;fs.rmSync(root,{recursive:true,force:true});});
test('dry run, draft release, owned derivatives and idempotence',async()=>{
 const f=await stage();assert.equal((await cleanup.run()).pendingFiles,0);assert.ok(fs.existsSync(f.file_path));
 remove(f);const before=await cleanup.run({dryRun:true});assert.equal(before.pendingFiles,1);assert.ok(fs.existsSync(f.file_path));
 database.db.prepare(`INSERT INTO document_chunks(file_path,content_hash,embedding_model,chunk_index,chunk_text,embedding_json,file_name) VALUES(?,?,?,?,?,?,?)`).run('attachment-version:'+f.version_id,'h','m',0,'text','[1]','fixture.txt');
 await cleanup.run();assert.equal(fs.existsSync(f.file_path),false);assert.equal(store.version(f.version_id),undefined);
 assert.equal(database.db.prepare('SELECT count(*) AS n FROM document_chunks').get().n,0);
 const n=cleanup.status().reclaimedBytes;await cleanup.run();assert.equal(cleanup.status().reclaimedBytes,n);
});
test('active operations and concurrent new grants prevent reclamation',async()=>{
 const f=await stage();remove(f);
 await cleanup.hold(async()=>{await cleanup.run();assert.ok(fs.existsSync(f.file_path));
 database.db.prepare('INSERT INTO attachment_drafts VALUES(?,?,?)').run('new-grant','draft',f.version_id);});
 await cleanup.run();assert.ok(fs.existsSync(f.file_path));database.db.prepare('DELETE FROM attachment_drafts WHERE token=?').run('new-grant');await cleanup.run();
});
test('durable fallback and brief snapshots retain physical data',async()=>{
 const f=await stage();remove(f);
 database.db.prepare("INSERT INTO sessions(id,model_id) VALUES('brief','fixture')").run();
 database.db.prepare("INSERT INTO workspace_task_briefs(session_id,kind,content_text,attachments_json) VALUES('brief','original','retain',?)").run(JSON.stringify([{asset_id:f.asset_id}]));
 await cleanup.run();assert.ok(fs.existsSync(f.file_path));
 database.db.prepare("DELETE FROM workspace_task_briefs WHERE session_id='brief'").run();await cleanup.run();assert.equal(fs.existsSync(f.file_path),false);
});
test('replaced paths and escaping symlinks are retained with retryable failure',async()=>{
 const f=await stage();remove(f);fs.unlinkSync(f.file_path);
 const external=path.join(root,'external.txt');fs.writeFileSync(external,'original');fs.symlinkSync(external,f.file_path);
 await cleanup.run();assert.equal(fs.readFileSync(external,'utf8'),'original');assert.ok(fs.lstatSync(f.file_path).isSymbolicLink());assert.ok(cleanup.status().retryableFailures>0);
 fs.unlinkSync(f.file_path);await cleanup.run();assert.equal(cleanup.status().retryableFailures,0);
});
test('omitted message grants, forks, shared paths and durable fallbacks remain owners',async()=>{
 const f=await stage();remove(f);
 const sessions=require('../src/main/sessionManager');
 sessions.getOrCreateSession('owner','fixture');sessions.getOrCreateSession('fork','fixture');
 const msg=sessions.saveMessage('owner','user','attachment',[]);
 const fork=sessions.saveMessage('fork','user','fork',[]);
 const insert=database.db.prepare('INSERT INTO message_attachments(message_id,file_path,mime_type,asset_id,version_id,omitted) VALUES(?,?,?,?,?,?)');
 insert.run(msg.id,f.file_path,f.mime_type,f.asset_id,f.version_id,1);
 insert.run(fork.id,f.file_path,f.mime_type,f.asset_id,f.version_id,0);
 await cleanup.run();assert.ok(fs.existsSync(f.file_path),'omission is restorable');
 database.db.prepare('DELETE FROM messages WHERE id=?').run(msg.id);await cleanup.run();assert.ok(fs.existsSync(f.file_path),'fork owns data');
 database.db.prepare('DELETE FROM messages WHERE id=?').run(fork.id);
 const other=await stage();
 database.db.prepare('UPDATE attachment_versions SET snapshot_path=? WHERE id=?').run(f.file_path,other.version_id);
 await cleanup.run();assert.ok(fs.existsSync(f.file_path),'fallback needs copy even without owning copy version');
 remove(other);await cleanup.run();assert.equal(fs.existsSync(f.file_path),false);
});
test('filesystem failures retry and unrelated indexes survive',async()=>{
 const f=await stage();remove(f);
 database.db.prepare('INSERT INTO document_chunks(file_name,file_path,content_hash,embedding_model,chunk_index,chunk_text,embedding_json) VALUES(?,?,?,?,?,?,?)').run('project','/project/document','h','m',0,'project text','[1]');
 const unlink=fs.unlinkSync;
 fs.unlinkSync=file=>{if(path.basename(file)===path.basename(f.file_path))throw Object.assign(new Error('fixture'),{code:'EACCES'});return unlink(file);};
 try {await cleanup.run();assert.ok(fs.existsSync(f.file_path));assert.ok(cleanup.status().retryableFailures>0);}finally{fs.unlinkSync=unlink;}
 await cleanup.run();assert.equal(fs.existsSync(f.file_path),false);
 assert.equal(database.db.prepare("SELECT count(*) AS n FROM document_chunks WHERE file_path='/project/document'").get().n,1);
});
test('interruption after unlink resumes from persistent receipt without double accounting',async()=>{
 const f=await stage();remove(f);fs.unlinkSync(f.file_path);
 const before=cleanup.status().reclaimedBytes;await cleanup.run();assert.equal(cleanup.status().reclaimedBytes,before);
 assert.equal(database.db.prepare('SELECT 1 FROM attachment_cleanup_files WHERE file_path=?').get(f.file_path),undefined);
});
test('restart expires classified drafts; unclassified legacy remains unresolved',async()=>{
 const f=await stage();database.db.prepare("UPDATE attachment_draft_lifetimes SET epoch='previous-process'").run();database.closeDatabase();database.initDatabase();await cleanup.run();assert.equal(fs.existsSync(f.file_path),false);
 const old=path.join(store.directory(),'old.txt');fs.writeFileSync(old,'legacy');
 database.db.prepare('INSERT INTO attachment_assets VALUES(?)').run('old');
 database.db.prepare("INSERT INTO attachment_versions(id,asset_id,storage_kind,file_path,name,mime_type,legacy) VALUES('old','old','managed',?,'old','text/plain',1)").run(old);
 await cleanup.run();assert.ok(fs.existsSync(old));assert.ok(cleanup.status().unresolvedLegacyItems>0);
});
test('a reference created while cleanup yields wins the final ownership recheck',async()=>{
 const f=await stage();remove(f);
 const creation=new Promise(resolve=>setImmediate(()=>{database.db.prepare('INSERT INTO attachment_drafts VALUES(?,?,?)').run('racing','draft',f.version_id);resolve();}));
 await cleanup.run();await creation;assert.ok(fs.existsSync(f.file_path));
 database.db.prepare("DELETE FROM attachment_drafts WHERE token='racing'").run();await cleanup.run();
});
test('partially written uploads have retryable creation receipts',async()=>{
 const open=fs.promises.open;
 fs.promises.open=async(...args)=>{
   const handle=await open(...args);
   if(args[1]==='wx') handle.writeFile=async bytes=>{await handle.write(bytes.subarray(0,2));throw Object.assign(new Error('fixture full disk'),{code:'ENOSPC'});};
   return handle;
 };
 const before=fs.readdirSync(store.directory());
 try {await assert.rejects(stage(),/full disk/);}finally{fs.promises.open=open;}
 await cleanup.run();assert.deepEqual(fs.readdirSync(store.directory()),before);
});
test('replaced managed roots are refused and can resume after restoration',async()=>{
 const f=await stage();remove(f);const directory=store.directory(),held=directory+'.held';
 fs.renameSync(directory,held);fs.mkdirSync(directory);
 try {await cleanup.run();assert.ok(cleanup.status().retryableFailures>0);assert.ok(fs.existsSync(path.join(held,path.basename(f.file_path))));}
 finally {fs.rmdirSync(directory);fs.renameSync(held,directory);}
 await cleanup.run();assert.equal(fs.existsSync(f.file_path),false);
});
test('conversation deletion revokes abandoned draft grants',async()=>{
 const sessions=require('../src/main/sessionManager');sessions.getOrCreateSession('draft','fixture');
 const f=await stage();sessions.deleteSession('draft');await cleanup.run();
 assert.equal(fs.existsSync(f.file_path),false);assert.equal(database.db.prepare("SELECT count(*) AS n FROM attachment_drafts WHERE session_id='draft'").get().n,0);
});
test('verified migration relocates creation receipts without expiring active drafts',async()=>{
 const f=(await store.stage([{name:'migration.txt',dataUrl:'data:text/plain;base64,aGVsbG8='}],{sessionId:'migration-draft'}))[0], destination=fs.mkdtempSync(path.join(os.tmpdir(),'cleanup-migrated-'));
 try {
   await require('../src/main/dataMigration').migrateAppData(destination);
   const v=store.version(f.version_id);assert.ok(v.file_path.startsWith(destination+path.sep));
   assert.ok(database.db.prepare('SELECT 1 FROM attachment_drafts WHERE token=?').get(f.draft_token));
   assert.ok(database.db.prepare('SELECT 1 FROM attachment_cleanup_files WHERE file_path=?').get(v.file_path));
   remove(f);await cleanup.run();assert.equal(fs.existsSync(v.file_path),false);
 } finally {database.closeDatabase();fs.rmSync(destination,{recursive:true,force:true});}
});
