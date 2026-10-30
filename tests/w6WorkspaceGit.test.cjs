'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const Module = require('node:module');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w6-'));
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: { isReady: () => true, getPath: () => path.join(base, 'app') } };
  return load.call(this, name, ...args);
};
fs.mkdirSync(path.join(base, 'app'));
const db = require('../src/main/db');
db.initDatabase(path.join(base, 'app'));
const tools = require('../src/main/tools/agentTools');
const permissions = require('../src/main/toolPermissions');
const recovery = require('../src/main/recoveryStore');
const caps = require('../src/main/executionCapabilities');
const boundary = require('../src/main/workspaceGit');
let seq = 0;
function git(root, ...args) { return cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }); }
function fixture(repo = true) {
  const root = path.join(base, `workspace-${++seq}`); fs.mkdirSync(root);
  if (repo) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
    fs.writeFileSync(path.join(root, 'f.txt'), 'original\n'); git(root, 'add', 'f.txt'); git(root, 'commit', '-qm', 'initial');
  }
  const project = require('../src/main/projectManager').createProject({ name: `W6-${seq}`, root_path: root });
  const sessionId = `w6-${seq}`;
  require('../src/main/sessionManager').getOrCreateSession(sessionId, 'model', project.id);
  return { root, project, sessionId };
}
function call(f, name, args = {}, extra = {}) {
  return tools.executeAgentTool({ name, arguments: args, sessionId: f.sessionId, permissionMode: 'workspace_write', ...extra });
}
function guard(f, name, args, extra = {}) {
  return permissions.guardTool({ name, args, sessionId: f.sessionId, project: f.project, permissionMode: 'workspace_write', requestApproval: async () => { throw Error('Unexpected approval'); }, ...extra });
}
test.after(() => { db.closeDatabase(); Module._load = load; fs.rmSync(base, { recursive: true, force: true }); });

test('ordinary native inspection, stage/unstage, commit, branch and clean switch are automatic', async () => {
  const f = fixture();
  for (const [name,args] of [['git_status',{}],['git_diff',{}],['git_log',{}],['git_show',{ref:'HEAD'}],['git_blame',{relative_path:'f.txt'}],['git_branch',{}]]) {
    const out = await call(f,name,args); assert.notEqual(out.success,false,JSON.stringify(out));
  }
  fs.writeFileSync(path.join(f.root,'f.txt'),'changed\n');
  assert.notEqual((await call(f,'git_stage',{paths:['f.txt']})).success,false);
  assert.notEqual((await call(f,'git_unstage',{paths:['f.txt']})).success,false);
  assert.equal(git(f.root,'diff','--cached'),'');
  await call(f,'git_stage',{paths:['f.txt']});
  const committed = await call(f,'git_commit',{message:'W6 local commit'});
  assert.ok(committed.hash,JSON.stringify(committed));
  assert.equal(git(f.root,'remote'),'');
  assert.equal(git(f.root,'log','-1','--format=%an <%ae>').trim(),'Fixture <fixture@example.test>');
  assert.notEqual((await call(f,'git_create_branch',{name:'side',switch:false})).success,false);
  assert.notEqual((await call(f,'git_switch',{ref:'side'})).success,false);
  assert.equal(git(f.root,'branch','--show-current').trim(),'side');
});

test('automatic commit and branch switch disable hooks and configured signers', async () => {
  const f=fixture(), marker=path.join(base,'HOOK_ESCAPED');
  const hook=path.join(f.root,'.git','hooks','pre-commit');
  fs.writeFileSync(hook,`#!/bin/sh\ntouch '${marker}'\nexit 42\n`,{mode:0o755});
  git(f.root,'config','commit.gpgSign','true'); git(f.root,'config','gpg.program','/must-not-execute');
  fs.writeFileSync(path.join(f.root,'f.txt'),'hook check\n'); await call(f,'git_stage',{paths:['f.txt']});
  const out=await call(f,'git_commit',{message:'no hooks'}); assert.ok(out.hash,JSON.stringify(out));
  assert.equal(fs.existsSync(marker),false);
});

test('stash captures actual tracked bytes; list/show are automatic; pop requires approval', async () => {
  const f=fixture(); fs.writeFileSync(path.join(f.root,'f.txt'),'preserve me\n');
  const out=await call(f,'git_stash',{action:'push'}); assert.notEqual(out.success,false,JSON.stringify(out)); assert.ok(out.recoveryCheckpointId);
  const row=db.db.prepare('SELECT manifest_json FROM recovery_checkpoints WHERE id=?').get(out.recoveryCheckpointId);
  const rec=JSON.parse(row.manifest_json).paths['f.txt'];
  assert.equal(rec.hash,require('node:crypto').createHash('sha256').update('preserve me\n').digest('hex'));
  assert.equal(fs.readFileSync(path.join(f.root,'f.txt'),'utf8'),'original\n');
  assert.match((await call(f,'git_stash',{action:'list'})).output,/Continuum stash/);
  assert.match((await call(f,'git_stash',{action:'show'})).output,/preserve me/);
  await assert.rejects(guard(f,'git_stash',{action:'pop'}),/approval denied/);
});

test('incomplete stash coverage blocks mutation even when a checkpoint exists', async () => {
  const f=fixture(); fs.writeFileSync(path.join(f.root,'f.txt'),'keep\n');
  const original=recovery.captureOperation;
  recovery.captureOperation=async()=>({checkpointId:999,coverage:{complete:true},manifest:{paths:{}}});
  try {
    const out=await call(f,'git_stash',{action:'push'});
    assert.equal(out.code,'GIT_RECOVERY_INCOMPLETE'); assert.equal(out.operation_executed,false);
    assert.equal(git(f.root,'stash','list'),''); assert.equal(fs.readFileSync(path.join(f.root,'f.txt'),'utf8'),'keep\n');
  } finally { recovery.captureOperation=original; }
});

test('changed state after recovery authorization cannot execute; completed grants cannot replay', async () => {
  const f=fixture(), args={action:'push'}; fs.writeFileSync(path.join(f.root,'f.txt'),'first\n');
  const approval=await guard(f,'git_stash',args);
  fs.writeFileSync(path.join(f.root,'f.txt'),'second\n');
  const blocked=await call(f,'git_stash',args,{approval,permissionGranted:true}); assert.equal(blocked.code,'GIT_RECOVERY_REQUIRED');
  assert.equal(git(f.root,'stash','list'),'');
  const next=await guard(f,'git_stash',args);
  assert.notEqual((await call(f,'git_stash',args,{approval:next,permissionGranted:true})).success,false);
  assert.equal((await call(f,'git_stash',args,{approval:next,permissionGranted:true})).code,'APPROVAL_REQUIRED');
});

test('forged recovery grant is rejected by the native capability boundary', async()=>{
  const f=fixture(),args={action:'push'}; fs.writeFileSync(path.join(f.root,'f.txt'),'keep');
  const approval=await guard(f,'git_stash',args); approval.gitRecovery.checkpointId=123456;
  const out=await call(f,'git_stash',args,{approval,permissionGranted:true}); assert.equal(out.code,'APPROVAL_REQUIRED');
  assert.equal(git(f.root,'stash','list'),'');
});

test('cancellation and stale permission revisions prevent Git mutations', async()=>{
  const f=fixture(),args={name:'cancelled',switch:false};
  const controller=new AbortController();controller.abort();
  const cancelled=await call(f,'git_create_branch',args,{signal:controller.signal}); assert.equal(cancelled.success,false); assert.equal(cancelled.code,'GIT_OPERATION_CANCELLED');
  const approval=await guard(f,'git_create_branch',args); approval.policyRevision=-1;
  const stale=await call(f,'git_create_branch',args,{approval,permissionGranted:true});assert.equal(stale.code,'PERMISSION_REVOKED');
  assert.doesNotMatch(git(f.root,'branch'),/cancelled/);
});

test('dirty switches and unauthorized staging preserve content', async()=>{
  const f=fixture();await call(f,'git_create_branch',{name:'side',switch:false});fs.writeFileSync(path.join(f.root,'f.txt'),'dirty\n');
  const out=await call(f,'git_switch',{ref:'side'});assert.equal(out.success,false);
  assert.equal(git(f.root,'branch','--show-current').trim(),'main');
  assert.equal((await call(f,'git_stage',{paths:['../outside']})).success,false);
  assert.equal(fs.readFileSync(path.join(f.root,'f.txt'),'utf8'),'dirty\n');
});

test('non-Git file reads/edits, tests and recovery remain available without init', async()=>{
  const f=fixture(false);fs.writeFileSync(path.join(f.root,'f.txt'),'hello\n');
  assert.notEqual((await call(f,'read_project_file',{relative_path:'f.txt'})).success,false);
  const edited=await call(f,'write_project_file',{relative_path:'new.txt',content:'new\n'});assert.notEqual(edited.success,false,JSON.stringify(edited));
  assert.ok(edited.recoveryCheckpointId);
  fs.writeFileSync(path.join(f.root,'pass.cjs'),"require('node:test')('pass',()=>{});");
  const out=await call(f,'run_tests',{command:'node --test --test-reporter=tap pass.cjs'});assert.equal(out.verificationState,'passed',JSON.stringify(out));
  const status=await call(f,'git_status');assert.equal(status.code,'NOT_A_GIT_REPOSITORY');assert.equal(status.side_effects,false);
  assert.match(status.error,/recovery remain available/);assert.equal(fs.existsSync(path.join(f.root,'.git')),false);
});

test('parent and outside gitfile metadata are rejected; nested repository uses its own root',async()=>{
  const parent=fixture();const child=path.join(parent.root,'child');fs.mkdirSync(child);
  assert.equal(boundary.repository(child).state,'outside');
  await assert.rejects(tools.runGit(child,['status']),{code:'GIT_REPOSITORY_OUTSIDE_WORKSPACE'});
  git(child,'init','-q'); assert.equal(boundary.repository(child).state,'detected');
  const worktree=path.join(base,`linked-${seq}`);git(parent.root,'worktree','add','-qb','linked',worktree);
  assert.equal(boundary.repository(worktree).state,'outside');
  await assert.rejects(tools.runGit(worktree,['status']),{code:'GIT_REPOSITORY_OUTSIDE_WORKSPACE'});
  const fake=fixture(false);fs.symlinkSync(path.join(parent.root,'.git'),path.join(fake.root,'.git'));assert.equal(boundary.repository(fake.root).state,'outside');
});

test('Git inspection masks workspace sockets while shell still rejects them',async()=>{
  const f=fixture();const server=require('node:net').createServer();const socket=path.join(f.root,'scratch.sock');
  await new Promise(resolve=>server.listen(socket,resolve));
  try {
    const status=await call(f,'git_status');assert.notEqual(status.success,false,JSON.stringify(status));
    const filesystem=require('../src/main/sandboxFilesystem');
    assert.throws(()=>filesystem.resolveFilesystem({workspace:f.root,protectGitMetadata:true}),/socket path/);
    const plan=filesystem.resolveFilesystem({workspace:f.root,maskWorkspaceSockets:true});
    const i=plan.mounts.indexOf(socket);assert.deepEqual(plan.mounts.slice(i-2,i+1),['--ro-bind','/dev/null',socket]);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('capability state is regenerated for repository creation/deletion and mode changes',()=>{
  const f=fixture(false);assert.match(caps.section('workspace_write',f.root),/Git: not detected/);
  git(f.root,'init','-q');assert.match(caps.section('workspace_write',f.root),/hooks disabled/);
  assert.doesNotMatch(caps.section('full_access',f.root),/Workspace Git tools/);
  fs.rmSync(path.join(f.root,'.git'),{recursive:true});assert.match(caps.section('workspace_write',f.root),/Git: not detected/);
});

test('remote, destructive and other-mode policies retain authorization',()=>{
  const {decideToolApproval: decide}=require('../src/main/toolApprovalPolicy');
  const input={native:true,mode:'workspace_write',workspaceRoot:base};
  assert.equal(decide({...input,tool:'git_sync',args:{action:'fetch'}}).decision,'allow');
  for(const action of ['pull','push']) assert.equal(decide({...input,tool:'git_sync',args:{action}}).decision,'ask');
  assert.equal(decide({...input,stage:'git_publication',tool:'git_sync',args:{action:'push'}}).decision,'ask');
  const names=tools.agentTools.map(t=>t.name);
  for(const name of ['git_restore','git_reset','git_clean','git_merge','git_rebase','git_push']) assert.equal(names.includes(name),false);
  assert.equal(decide({...input,tool:'git_commit',args:{message:'x'},mode:'read_only'}).decision,'block');
  assert.equal(decide({...input,tool:'git_commit',args:{message:'x'},mode:'ask_approval'}).decision,'ask');
});

test('conflicting native writes and background commands block Git without discarding work', async()=>{
  const f=fixture();const release=boundary.enter(f.root,'write_project_file',false);
  try { const out=await call(f,'git_create_branch',{name:'blocked',switch:false});assert.equal(out.code,'GIT_RECOVERY_REQUIRED'); }
  finally { release(); }
  const releaseGit=boundary.enter(f.root,'git_stash',true);
  try { const out=await call(f,'write_project_file',{relative_path:'f.txt',content:'lost'});assert.equal(out.success,false); }
  finally { releaseGit(); }
  const bg=require('../src/main/backgroundCommands'), original=bg.workspaceBusy;bg.workspaceBusy=()=>true;
  try { assert.equal((await call(f,'git_create_branch',{name:'blocked',switch:false})).code,'GIT_RECOVERY_REQUIRED'); }
  finally { bg.workspaceBusy=original; }
  assert.equal(fs.readFileSync(path.join(f.root,'f.txt'),'utf8'),'original\n');
  assert.doesNotMatch(git(f.root,'branch'),/blocked/);
});

test('repository core.worktree cannot redirect native Git to unrelated files',async()=>{
  const f=fixture(),outside=fixture(false);fs.writeFileSync(path.join(outside.root,'PRIVATE.txt'),'outside');
  git(f.root,'config','core.worktree',outside.root);
  const out=await call(f,'git_status');assert.notEqual(out.success,false,JSON.stringify(out));assert.doesNotMatch(out.output,/PRIVATE/);
});

test('oversize tracked data is rejected before stash capture or deletion',async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.root,'f.txt'),Buffer.alloc(recovery.RECOVERY_MAX_FILE_BYTES+1,65));
  const out=await call(f,'git_stash',{action:'push'});assert.equal(out.code,'GIT_RECOVERY_INCOMPLETE');
  assert.equal(fs.statSync(path.join(f.root,'f.txt')).size,recovery.RECOVERY_MAX_FILE_BYTES+1);assert.equal(git(f.root,'stash','list'),'');
});

test('stash recovery captures affected paths rather than unrelated tracked files',async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.root,'unchanged.bin'),Buffer.alloc(recovery.RECOVERY_MAX_FILE_BYTES+1,66));
  git(f.root,'add','unchanged.bin');git(f.root,'commit','-qm','large unchanged file');
  fs.writeFileSync(path.join(f.root,'f.txt'),'recover only this\n');
  const out=await call(f,'git_stash',{action:'push'});assert.notEqual(out.success,false,JSON.stringify(out));
  const row=db.db.prepare('SELECT manifest_json FROM recovery_checkpoints WHERE id=?').get(out.recoveryCheckpointId);
  assert.deepEqual(Object.keys(JSON.parse(row.manifest_json).paths),['f.txt']);
});

test('internal gitfiles work and external common metadata is blocked',async()=>{
  const f=fixture();fs.renameSync(path.join(f.root,'.git'),path.join(f.root,'.metadata'));
  fs.writeFileSync(path.join(f.root,'.git'),'gitdir: .metadata\n');
  assert.equal(boundary.repository(f.root).state,'detected');assert.notEqual((await call(f,'git_status')).success,false);
  const other=fixture();fs.writeFileSync(path.join(f.root,'.metadata','commondir'),path.join(other.root,'.git'));
  assert.equal(boundary.repository(f.root).state,'outside');assert.equal((await call(f,'git_status')).code,'GIT_REPOSITORY_OUTSIDE_WORKSPACE');
});
