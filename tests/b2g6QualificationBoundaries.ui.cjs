'use strict';
const { _electron } = require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
async function main(){
 const id=JSON.parse(fs.readFileSync(process.argv[2]));
 const temp=fs.mkdtempSync('/tmp/b2g6-wrong-profile-');let app;
 try{
  const env={...process.env,HOME:id.childHome,NODE_ENV:'production',XDG_CONFIG_HOME:id.childHome+'/.config',XDG_CACHE_HOME:id.childHome+'/.cache',XDG_DATA_HOME:id.childHome+'/.local/share'};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:'/opt/Continuum/continuum',chromiumSandbox:true,args:['--user-data-dir='+temp,'--disable-gpu'],env,timeout:45000});
  const window=await app.firstWindow();await window.waitForFunction(()=>!!window.api?.getWorkspaceNetworkStatus);
  const status=await window.evaluate(()=>window.api.getWorkspaceNetworkStatus());assert.equal(status.available,false);assert.equal(status.code,'QUALIFICATION_UNAVAILABLE');assert.ok(status.blockers.some(s=>s.includes('boundary')));
  const config=await window.evaluate(()=>window.api.getConfig());assert.equal(config.workspaceNetwork.policy,'isolated');
  const rejected=await window.evaluate(async()=>{try{await window.api.setWorkspaceNetwork({version:2,policy:'trusted_development'});return false;}catch{return true;}});assert.equal(rejected,true);
  console.log(JSON.stringify({passed:true,wrongProfileRejected:true,status,productionQualified:false}));
 }finally{await app?.close();fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
