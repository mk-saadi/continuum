'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path'), Module=require('node:module');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'failed-str-native-')), load=Module._load;
Module._load=function(name,...args){if(name==='electron')return {app:{isReady:()=>true,getPath:()=>directory}};return load.call(this,name,...args);};
const database=require('../src/main/db'); database.initDatabase(directory);
const root=path.join(directory,'project');fs.mkdirSync(root);
const project=require('../src/main/projectManager').createProject({name:'E2',root_path:root});
require('../src/main/sessionManager').getOrCreateSession('e2','model',project.id);
const {executeAgentTool,atomicWriteFile}=require('../src/main/tools/agentTools');
const run=(name,args)=>executeAgentTool({name,arguments:args,sessionId:'e2',permissionMode:'workspace_write'});
test.after(()=>{database.closeDatabase();Module._load=load;fs.rmSync(directory,{recursive:true,force:true});});
const put=(name,text)=>fs.writeFileSync(path.join(root,name),text);
const get=name=>fs.readFileSync(path.join(root,name),'utf8');
const edit=(old_str,new_str,relative_path='a.css')=>({relative_path,old_str,new_str});

const fixture=require('./fixtures/failedStrEdits.json');
for(const request of fixture.requests)test(`recorded failed str request ${request.index}: ${request.name}`,async()=>{
 const file='src/components/main-app/ModelSelectorModal.jsx';
 fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});
 const original=fixture.snapshots[request.snapshot];put(file,original);
 const result=await run(request.name,request.args);
 assert.equal(result.success,request.expected_success,JSON.stringify(result));
 if(!request.expected_success){assert.equal(get(file),original);assert.equal(result.zero_writes,true);assert.ok(result.nearby_source[0].start_line>400);assert.match(result.error,/omits existing source at line 508.*<\/span>/);}
});
test('bare patch hunks preserve significant string whitespace and atomicity',async()=>{
 put('first.js','first();\n');put('protected.jsx','const value=`first\n  literal`;');
 const result=await run('apply_patch',{patch:'--- a/first.js\n+++ b/first.js\n@@\n-first();\n+changed();\n--- a/protected.jsx\n+++ b/protected.jsx\n@@\n-const value=`first\n- literal`;\n+const value=`other`;\n'});
 assert.equal(result.success,false);assert.equal(result.zero_writes,true);assert.equal(result.normalization_blocker.kind,'a template literal');
 assert.equal(get('first.js'),'first();\n');assert.equal(get('protected.jsx'),'const value=`first\n  literal`;');
});
test('normalized duplicate patch remains ambiguous',async()=>{
 put('duplicate.jsx','const a=(\n  <X />\n    <X />\n);');
 const result=await run('apply_patch',{patch:'--- a/duplicate.jsx\n+++ b/duplicate.jsx\n@@\n- <X />\n+ <Y />\n'});
 assert.equal(result.success,false);assert.equal(result.code,'PATCH_CONTEXT_AMBIGUOUS');assert.equal(result.zero_writes,true);
});
test('batch failure explicitly labels uncommitted source',async()=>{
 put('stage.jsx','const a=(\n  <X />\n);');
 const result=await run('edit_project_files',{edits:[edit('<X />','<Y />','stage.jsx'),edit('<Missing />','<Z />','stage.jsx')]});
 assert.equal(result.success,false);assert.equal(result.source_state,'staged-batch');assert.equal(result.staged_edits_before_failure,1);assert.equal(get('stage.jsx'),'const a=(\n  <X />\n);');
});
