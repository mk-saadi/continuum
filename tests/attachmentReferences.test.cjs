'use strict';
// ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/attachmentReferences.test.cjs
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), Module=require('node:module');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'attachment-references-'));
const handlers=new Map(), load=Module._load;
let chosen=[];
Module._load=function(name,...args) {
  if(name==='electron')return {app:{isReady:()=>true,getPath:()=>path.join(root,'profile')},
    ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn),removeHandler:channel=>handlers.delete(channel)},
    dialog:{showOpenDialog:async()=>({canceled:!chosen.length,filePaths:chosen})},shell:{openPath:async()=>''}};
  if(name==='./modelCapabilities' && args[0]?.filename.endsWith('/attachmentAccess.js')) return {queryCapabilities:async()=>({image:true,audio:true,video:true})};
  return load.call(this,name,...args);
};
const database=require('../src/main/db');database.initDatabase();
const store=require('../src/main/attachmentStore'), sessions=require('../src/main/sessionManager');
const {prepareChatMessages,messageForModel,rebuildChatMessages}=require('../src/main/promptBuilder');
const reader=require('../src/main/attachmentReader');
const dispose=require('../src/main/ipcHandlers').registerIpcHandlers({isTrustedSender:event=>event.trusted===true,getEngineConfig:()=>({modelPath:'/fixture.gguf',port:9})});
const sender={once(){},isDestroyed:()=>false,send(){}};
const event={trusted:true,sender};
const ipc=(name,payload)=>handlers.get(name)(event,payload);
const target=sessionId=>({sessionId,modelId:'/fixture.gguf',activeChatProvider:{type:'local'}});
const write=(name,text)=>{const file=path.join(root,name);fs.writeFileSync(file,text);return file;};
async function stage(file,sessionId,keepCopy=false) {return store.stage([{nativePath:file}],{sessionId,keepCopy});}
async function persist(sessionId,files) {
  await store.withSnapshots(sessionId,files,()=>prepareChatMessages({sessionId,modelId:'fixture',userText:'Inspect fixtures',attachments:files}));
  return sessions.loadSession(sessionId).messages.at(-1);
}
test.after(()=>{dispose();database.closeDatabase();Module._load=load;fs.rmSync(root,{recursive:true,force:true});});

test('native provenance is required; references create no managed copy and tools enforce ownership',async()=>{
  const file=write('source.txt','original source');
  await assert.rejects(ipc('attachment:stage',{...target('provenance'),files:[{nativePath:file}]}),/Disk provenance/);
  await assert.rejects(ipc('file:process-uploads',{...target('provenance'),files:[file]}),/paths are not attachment authorization/);
  const token=await ipc('attachment:bridge');
  const other={once(){}};
  await assert.rejects(handlers.get('attachment:stage')({trusted:true,sender:other},{...target('provenance'),bridgeToken:token,files:[{nativePath:file}]}),/Disk provenance/);
  const files=await ipc('attachment:stage',{...target('provenance'),bridgeToken:token,files:[{nativePath:file}]});
  assert.equal(files[0].storage_kind,'referenced');assert.equal(files[0].file_path,file);
  assert.match(files[0].fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(store.directory()),false,'no full managed copy for a reference');
  const message=await persist('provenance',files), row=message.attachments[0];
  const ref=reader.reference(row);
  assert.match(reader.read({attachment_id:ref},'provenance').content,/original source/);
  sessions.getOrCreateSession('foreign','fixture');
  assert.throws(()=>reader.resolve(ref,'foreign'),/not attached to this conversation/);
  await assert.rejects(ipc('attachment:preview',{sessionId:'foreign',attachment:{id:row.id}}),/not owned/);
  await assert.rejects(ipc('attachment:preview',{attachment:row}),/conversation is required/);
  await assert.rejects(ipc('session:prepare-messages',{sessionId:'foreign',modelId:'fixture',userText:'bad',attachments:[{file_path:file,mime_type:'text/plain'}]}),/paths are not authorization/);
  assert.throws(()=>require('../src/main/fileUploads').validateAttachments([{...row,id:undefined,message_id:undefined}]),/Use a conversation attachment ID/);
});

test('staged drafts move to a new project conversation and stay conversation-scoped',async()=>{
  const source=write('retarget.txt','retargeted bytes');
  const files=await stage(source,'retarget-old');
  await assert.rejects(store.withSnapshots('retarget-new',files,()=>null),/Invalid attachment draft grant/);
  await assert.rejects(ipc('attachment:retarget',{fromSessionId:'retarget-other',toSessionId:'retarget-new',attachments:files}),/Invalid attachment draft grant/);
  const moved=await ipc('attachment:retarget',{fromSessionId:'retarget-old',toSessionId:'retarget-new',attachments:files});
  assert.equal(moved.length,1);
  assert.equal(moved[0].draft_token,files[0].draft_token);
  assert.equal(moved[0].session_id,'retarget-new');
  assert.equal(moved[0].version_id,files[0].version_id);
  assert.equal((await store.inspect(moved[0],'retarget-new')).status,'ready');
  await assert.rejects(store.withSnapshots('retarget-old',files,()=>null),/Invalid attachment draft grant/);
  const message=await persist('retarget-new',moved);
  assert.equal(message.attachments[0].version_id,files[0].version_id);
  assert.equal((await store.inspect(message.attachments[0],'retarget-new')).status,'ready');
});

test('changed, replaced, missing and relinked files require explicit recovery; IDs survive',async()=>{
  const file=write('changes.txt','version one');const message=await persist('changes',await stage(file,'changes'));
  let row=message.attachments[0];const ref=reader.reference(row), asset=row.asset_id;
  fs.writeFileSync(file,'version two');
  assert.equal((await store.inspect(row,'changes')).status,'ATTACHMENT_CHANGED');
  assert.throws(()=>reader.read({attachment_id:ref},'changes'),/source has changed/);
  await assert.rejects(store.withSnapshots('changes',[],()=>rebuildChatMessages({sessionId:'changes',modelId:'fixture'})),/Nothing from the changed file was sent/);
  row=await store.recover(row,'changes','accept');
  assert.equal(row.id,message.attachments[0].id);assert.equal(row.asset_id,asset);
  assert.match(reader.read({attachment_id:ref},'changes').content,/version two/);
  const replacement=write('replacement.txt','version two');fs.renameSync(replacement,file);
  assert.equal((await store.inspect(row,'changes')).status,'ATTACHMENT_CHANGED','replacement inode needs acknowledgement even for identical content');
  row=await store.recover(row,'changes','accept');
  const moved=path.join(root,'moved.txt');fs.renameSync(file,moved);
  assert.equal((await store.inspect(row,'changes')).status,'ATTACHMENT_MISSING');
  chosen=[moved];row=await ipc('attachment:recover',{sessionId:'changes',attachment:{id:row.id},action:'locate',selectedPath:'/not-authorized'});
  assert.equal(row.file_path,moved);assert.equal(row.id,message.attachments[0].id);
  assert.equal(reader.resolve(ref,'changes').file_path,moved);
  chosen=[write('different.txt','different bytes')];
  await assert.rejects(ipc('attachment:recover',{sessionId:'changes',attachment:{id:row.id},action:'locate'}),/different content/);
  row=await ipc('attachment:recover',{sessionId:'changes',attachment:{id:row.id},action:'replace'});
  assert.match(reader.read({attachment_id:ref},'changes').content,/different bytes/);
  await store.recover(row,'changes','omit');
  assert.throws(()=>reader.resolve(ref,'changes'),/not attached/);
  const omitted=await store.withSnapshots('changes',[],()=>rebuildChatMessages({sessionId:'changes',modelId:'fixture'}));
  assert.match(JSON.stringify(omitted),/explicitly omitted by user/);
  assert.equal(fs.readFileSync(row.file_path,'utf8'),'different bytes');
  const copiedWhileOmitted=await store.recover(row,'changes','copy');
  assert.equal(copiedWhileOmitted.omitted,1,'changing storage does not silently restore revoked media');
  assert.throws(()=>reader.resolve(ref,'changes'),/not attached/);
  assert.deepEqual(await require('../src/main/ragManager').indexDocuments([copiedWhileOmitted]),[]);
});

test('keep a copy and a fork fallback survive source deletion without changing the source',async()=>{
  const source=write('durable.txt','durable original');
  const initial=await persist('copy',await stage(source,'copy'));
  const fork=sessions.branchChat('copy',initial.id);
  const forkId=fork.sessionId || fork.id;
  const row=initial.attachments[0], forkRow=sessions.loadSession(forkId).messages[0].attachments[0];
  assert.equal(forkRow.asset_id,row.asset_id);assert.equal(forkRow.version_id,row.version_id);
  const copied=await store.recover(row,'copy','copy');
  assert.equal(copied.storage_kind,'managed');assert.equal(fs.readFileSync(source,'utf8'),'durable original');
  fs.unlinkSync(source);
  const forkStatus=await store.inspect(forkRow,forkId);
  assert.equal(forkStatus.status,'ATTACHMENT_MISSING');assert.equal(forkStatus.has_copy,true);
  const recovered=await store.recover(forkRow,forkId,'use-copy');
  assert.equal(recovered.storage_kind,'managed');
  assert.match(reader.read({attachment_id:reader.reference(recovered)},forkId).content,/durable original/);
  const stagedCopy=await stage(write('at-selection.txt','snapshot'),'selection-copy',true);
  fs.unlinkSync(path.join(root,'at-selection.txt'));
  await persist('selection-copy',stagedCopy);
  assert.equal((await store.inspect(stagedCopy[0],'selection-copy')).status,'ready');
});

test('symlinks, inaccessible sources, immutable request bytes and revocation during capture',async()=>{
  const source=write('safe.txt','safe bytes');const files=await stage(source,'safe');const message=await persist('safe',files);
  const row=message.attachments[0], ref=reader.reference(row);
  const alias=path.join(root,'alias.txt');fs.symlinkSync(source,alias);
  await assert.rejects(stage(alias,'symlink'),/Symbolic-link/);
  fs.unlinkSync(source);fs.symlinkSync(write('other.txt','unapproved bytes'),source);
  await assert.rejects(store.verified(store.version(row.version_id)),/Symbolic-link/);
  fs.unlinkSync(source);fs.writeFileSync(source,'safe bytes');
  const accepted=await store.recover(row,'safe','accept');
  const originalOpen=fs.promises.open;
  try {fs.promises.open=async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});};
    assert.equal((await store.inspect(accepted,'safe')).status,'ATTACHMENT_UNREADABLE');
  } finally {fs.promises.open=originalOpen;}
  await store.withSnapshots('safe',[],async()=>{
    fs.writeFileSync(source,'changed after capture');
    const model=messageForModel({...message,attachments:[accepted]});
    assert.match(model.content,/safe bytes/);assert.ok(!model.content.includes('changed after capture'));
    assert.throws(()=>reader.read({attachment_id:ref},'safe'),/source has changed/,'tools revalidate instead of reusing the request snapshot');
  });
  await store.recover(accepted,'safe','accept');
  const v=store.version(store.ownedRow('safe',row.id).version_id);
  const captured=await store.verified(v);
  database.db.prepare('DELETE FROM message_attachments WHERE id=?').run(row.id);
  assert.throws(()=>reader.read({attachment_id:ref},'safe',null,null,captured),/not attached/);
});

test('versioned PDF/XLSX extraction and RAG never reuse changed or stale content',async()=>{
  const Excel=require('exceljs');const workbook=new Excel.Workbook();workbook.addWorksheet('Sheet').addRow(['old spreadsheet',123]);
  const source=path.join(root,'sheet.xlsx');fs.writeFileSync(source,await workbook.xlsx.writeBuffer());
  const message=await persist('documents',await stage(source,'documents'));let row=message.attachments[0];
  const ref=reader.reference(row);
  assert.match(reader.read({attachment_id:ref},'documents').content,/old spreadsheet/);
  assert.equal(fs.existsSync(source+'.extracted.txt'),false,'no derivatives written beside a referenced source');
  const rag=require('../src/main/ragManager');const embedder={modelKey:'fixture',embed:async()=>[1,1]};
  const indexed=await rag.indexDocuments([row],{embedder});assert.equal(indexed[0],'attachment-version:'+row.version_id);
  const oldVersion=row.version_id;
  workbook.worksheets[0].getCell('A1').value='new spreadsheet';fs.writeFileSync(source,await workbook.xlsx.writeBuffer());
  await assert.rejects(rag.retrieveContext('documents','spreadsheet',{embedder}),/source has changed/);
  row=await store.recover(row,'documents','accept');assert.notEqual(row.version_id,oldVersion);
  const chunks=await rag.retrieveContext('documents','spreadsheet',{embedder});
  assert.match(JSON.stringify(chunks),/new spreadsheet/);assert.ok(!JSON.stringify(chunks).includes('old spreadsheet'));
  assert.match(reader.read({attachment_id:ref},'documents').content,/new spreadsheet/);
});

test('legacy migration preserves row IDs, opaque references, brief snapshots and restart',async()=>{
  const file=write('legacy.txt','legacy original');
  const [legacy]=await require('../src/main/fileUploads').processUploads([file]);
  const workspace=path.join(root,'legacy-workspace');fs.mkdirSync(workspace);
  const project=require('../src/main/projectManager').createProject({name:'Legacy attachment brief',root_path:workspace});
  sessions.getOrCreateSession('legacy','fixture',project.id);const message=sessions.saveMessage('legacy','user','Legacy',[legacy]);
  require('../src/main/taskBriefs').captureBriefForUserMessage('legacy', message.id, 'Legacy', message.attachments);
  const id=message.attachments[0].id, ref=reader.reference(message.attachments[0]);
  database.closeDatabase();database.initDatabase();
  const row=sessions.loadSession('legacy').messages[0].attachments[0];
  assert.equal(row.id,id);assert.equal(row.storage_kind,'managed');assert.equal(row.file_path,legacy.file_path);
  assert.equal(reader.reference(row),ref);assert.match(reader.read({attachment_id:ref},'legacy').content,/legacy original/);
  assert.equal((await store.inspect(row,'legacy')).status,'ready');
  assert.match(JSON.stringify(require('../src/main/taskBriefs').buildTaskBriefSection('legacy')),/legacy original/);
  const fork=sessions.branchChat('legacy',message.id);
  assert.match(JSON.stringify(require('../src/main/taskBriefs').buildTaskBriefSection(fork.sessionId)),/legacy original/);
  const protectedPath=require('../src/main/localMedia').publicMediaPath;
  assert.equal(protectedPath(row.file_path),false);assert.equal(protectedPath(path.join(root,'changes.txt')),false);
  sessions.deleteSession('legacy');assert.equal(fs.existsSync(row.file_path),true);
  assert.throws(()=>reader.resolve(ref,'legacy'),/deleted/);
});

test('referenced attachments preserve delegated restrictions and fork brief identity',async()=>{
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  const project=require('../src/main/projectManager').createProject({name:'Attachment delegation',root_path:workspace});
  sessions.getOrCreateSession('delegation','fixture',project.id);
  const message=await persist('delegation',await stage(write('delegated.txt','delegated reference'),'delegation'));
  const row=message.attachments[0], ref=reader.reference(row);
  const contexts=require('../src/main/lspExecutionContext'), children=require('../src/main/subagents/sessionManager');
  const parent=contexts.createContext('delegation','workspace_write');
  const child=children.createSession({parentSessionId:'delegation'});
  const delegated=contexts.authorizeChild(child,parent,'read_only');
  const dispatch=executionContext=>require('../src/main/tools/agentTools').executeAgentTool({name:'read_project_file',arguments:{attachment_id:ref},sessionId:null,permissionMode:'read_only',executionContext,rootPath:workspace});
  assert.match((await dispatch(delegated)).content,/delegated reference/);
  assert.equal((await dispatch({...delegated})).code,'ATTACHMENT_UNAUTHORIZED');
  children.deleteSession(child.id);
  assert.equal((await dispatch(delegated)).code,'ATTACHMENT_UNAUTHORIZED');
  const copied=sessions.branchChat('delegation',message.id);
  const branch=sessions.loadSession(copied.sessionId).messages[0].attachments[0];
  const brief=rebuildChatMessages({sessionId:copied.sessionId,modelId:'fixture'});
  assert.match(JSON.stringify(brief),/delegated reference/);
  const moved=path.join(root,'delegated-moved.txt');fs.renameSync(row.file_path,moved);
  await store.recover(branch,copied.sessionId,'locate',moved);
  assert.match(JSON.stringify(await store.withSnapshots(copied.sessionId,[],()=>rebuildChatMessages({sessionId:copied.sessionId,modelId:'fixture'}))),/delegated reference/);
  assert.equal((await store.inspect(row,'delegation')).status,'ATTACHMENT_MISSING','relinking a fork does not rewrite the other conversation');
});

test('PDF references parse captured bytes and source changes cannot reuse prior extracted text',async()=>{
  const pdf=text=>{
    const stream=`BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
    const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let data='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${obj}\nendobj\n`;});const start=Buffer.byteLength(data);
    return Buffer.from(data+`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
  };
  const source=write('reference.pdf',pdf('first PDF version'));
  let row=(await persist('pdf-reference',await stage(source,'pdf-reference'))).attachments[0];
  const ref=reader.reference(row);assert.match(reader.read({attachment_id:ref},'pdf-reference').content,/first PDF version/);
  fs.writeFileSync(source,pdf('second PDF version'));
  assert.throws(()=>reader.read({attachment_id:ref},'pdf-reference'),/source has changed/);
  row=await store.recover(row,'pdf-reference','accept');
  const messages=await store.withSnapshots('pdf-reference',[],()=>rebuildChatMessages({sessionId:'pdf-reference',modelId:'fixture'}));
  assert.match(JSON.stringify(messages),/second PDF version/);assert.ok(!JSON.stringify(messages).includes('first PDF version'));
  assert.equal(fs.existsSync(source+'.extracted.txt'),false);
});

test('capture detects writes during reading and failed batches remove only their own managed copies',async()=>{
  const source=write('racing.txt','before race');
  const originalOpen=fs.promises.open;
  try {
    fs.promises.open=async(...args)=>{
      const handle=await originalOpen(...args), read=handle.read.bind(handle);
      handle.read=async(...readArgs)=>{const result=await read(...readArgs);fs.writeFileSync(source,'changed while reading');return result;};
      return handle;
    };
    await assert.rejects(stage(source,'racing'),/changed while it was being read/);
  } finally {fs.promises.open=originalOpen;}
  const bytes=Buffer.from('pasted text');
  const before=fs.existsSync(store.directory())?fs.readdirSync(store.directory()).sort():[];
  const drafts=database.db.prepare('SELECT COUNT(*) n FROM attachment_drafts').get().n;
  await assert.rejects(store.stage([{name:'pasted.txt',dataUrl:'data:text/plain;base64,'+bytes.toString('base64')},{nativePath:write('unsupported.exe','original executable')}],{sessionId:'failed-batch'}),/Supported formats/);
  assert.deepEqual(fs.readdirSync(store.directory()).sort(),before);
  assert.equal(database.db.prepare('SELECT COUNT(*) n FROM attachment_drafts').get().n,drafts);
  assert.equal(fs.readFileSync(source,'utf8'),'changed while reading');
  const [pasted]=await store.stage([{name:'pasted.txt',dataUrl:'data:text/plain;base64,'+bytes.toString('base64')}],{sessionId:'pathless-text'});
  assert.equal(pasted.storage_kind,'managed');assert.deepEqual(fs.readFileSync(pasted.file_path),bytes);
});

test('relocated app data preserves managed versions and old task-brief path aliases',async()=>{
  const oldRoot=require('../src/main/configStore').getConfig().appDataDirectory;
  const source=write('migration-source.txt','migration bytes');
  const [draft]=await stage(source,'migration-reference');
  const managed=await store.recover(draft,'migration-reference','copy');
  const previousPath=managed.file_path;
  const nextRoot=path.join(root,'migrated-data');
  fs.mkdirSync(path.join(nextRoot,'attachments'),{recursive:true});
  fs.copyFileSync(previousPath,path.join(nextRoot,'attachments',path.basename(previousPath)));
  const row=(await persist('migration-reference',[managed])).attachments[0];
  require('../src/main/dataMigration').relocateReferences(database.db,oldRoot,nextRoot);
  const updated=store.version(row.version_id);
  assert.equal(updated.file_path,path.join(nextRoot,'attachments',path.basename(previousPath)));
  assert.equal(store.rowForFile({file_path:previousPath},row.message_id).id,row.id);
  assert.equal(store.version(draft.version_id).file_path,source,'referenced source location is not guessed or relocated');
  // This test exercises the DB rewrite; restore the profile's root mapping for later checks.
  require('../src/main/dataMigration').relocateReferences(database.db,nextRoot,oldRoot);
});

test('referenced original images and mixed audio/video reach production cloud/local requests; stale renderer projections are rejected',async()=>{
  const fixtures=await require('./fixtures/attachmentImages.cjs').attachmentImages();
  const image=fixtures[0];const source=write('wire.png',image.bytes);
  const wav=path.join(root,'wire.wav'),video=path.join(root,'wire.mp4');
  const {spawnSync}=require('node:child_process');
  for(const args of [
    ['-f','lavfi','-i','sine=frequency=440:duration=0.1',wav],
    ['-f','lavfi','-i','color=c=blue:s=32x24:d=0.1','-c:v','mpeg4',video],
  ]) {const command=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-threads','1',...args],{encoding:'utf8'});assert.equal(command.status,0,command.stderr);}
  const files=await store.stage([source,wav,video].map(nativePath=>({nativePath})),{sessionId:'reference-wire'});
  const messages=await store.withSnapshots('reference-wire',files,()=>prepareChatMessages({sessionId:'reference-wire',modelId:'fixture',userText:'Inspect fixtures',attachments:files}));
  const {runMemoryChat}=await import('../src/lib/memoryChat.mjs');
  const complete=()=>Response.json({choices:[{message:{content:'Fixture complete'},finish_reason:'stop'}]});
  let outgoing;
  const local=require('../src/main/modelCapabilities').createMediaGuardedFetch(async(url,options)=>{
    if(url.endsWith('/props'))return Response.json({modalities:{vision:true,audio:true,video:true}});
    outgoing=JSON.parse(options.body);return complete();
  });
  await runMemoryChat({baseUrl:'http://127.0.0.1:8999',modelId:'fixture',messages,fetchImpl:local});
  let parts=outgoing.messages.at(-1).content;
  assert.ok(Array.isArray(parts));assert.deepEqual(Buffer.from(parts.find(p=>p.type==='image_url').image_url.url.split(',')[1],'base64'),image.bytes);
  assert.deepEqual(Buffer.from(parts.find(p=>p.type==='input_audio').input_audio.data,'base64'),fs.readFileSync(wav));
  assert.deepEqual(Buffer.from(parts.find(p=>p.type==='input_video').input_video.data,'base64'),fs.readFileSync(video));
  const clouds=require('../src/main/cloudProviders');clouds.saveCloudProvider({id:'reference-router',name:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',apiKey:'fixture'});
  const target={type:'cloud',provider:'reference-router',model:'fixture'};
  const cloud=clouds.createCloudFetch(target,{getMetadata:async()=>[{providerId:target.provider,modelId:target.model,providerName:'OpenRouter',capabilities:{image:true,audio:true,video:true}}],fetchImpl:async(_url,options)=>{outgoing=JSON.parse(options.body);return complete();}});
  await runMemoryChat({baseUrl:'https://fixture.invalid',modelId:'fixture',messages,fetchImpl:cloud,cloud:true});
  parts=outgoing.messages.at(-1).content;
  assert.deepEqual(Buffer.from(parts.find(p=>p.type==='video_url').video_url.url.split(',')[1],'base64'),fs.readFileSync(video));
  assert.ok(parts.filter(p=>p.type==='text').every(p=>!p.text.includes('base64,')));
  fs.writeFileSync(source,fixtures[1].bytes);
  await assert.rejects(ipc('engine:chat',{requestId:'stale-projection',sessionId:'reference-wire',modelId:'fixture',messages,activeChatProvider:{type:'local'}}),/source has changed/);
});

test('raw media URLs cannot bypass attachment ownership, including changed symlink targets inside an allowed project',async()=>{
  const workspace=path.join(root,'public-media');fs.mkdirSync(workspace);
  require('../src/main/projectManager').createProject({name:'Media boundary',root_path:workspace});
  const {PNG_BASE64}=await import('./fixtures/visionImages.mjs');const bytes=Buffer.from(PNG_BASE64,'base64');
  const source=path.join(workspace,'protected.png'), publicFile=path.join(workspace,'public.png');
  fs.writeFileSync(source,bytes);fs.writeFileSync(publicFile,bytes);
  const [file]=await stage(source,'preview-owner');
  const {publicMediaPath,serveMediaRequest}=require('../src/main/localMedia');
  assert.equal(publicMediaPath(source),false);assert.equal(publicMediaPath(publicFile),true);
  assert.deepEqual(Buffer.from((await store.preview(file,'preview-owner')).dataUrl.split(',')[1],'base64'),bytes);
  await assert.rejects(store.preview(file,'foreign'),/Invalid attachment draft grant/);
  const url=require('node:url').pathToFileURL(source).href.replace(/^file:/,'media:');
  assert.equal((await serveMediaRequest(new Request(url))).status,404);
  fs.unlinkSync(source);fs.symlinkSync(publicFile,source);
  assert.equal((await serveMediaRequest(new Request(url))).status,404);
});
