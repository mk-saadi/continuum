const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const Database = require('better-sqlite3');
test('overrides persist, remain isolated by model and can return to automatic', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY,value_json TEXT)');
  const original = Module._load;
  Module._load = function(name, parent, ...args) {
    if (parent?.filename.endsWith('/capabilityOverrides.js') && name === './db') return {db};
    if (parent?.filename.endsWith('/capabilityOverrides.js') && name === './cloudProviders') return {getCloudProviders: () => [{id:'cloud',baseUrl:'https://example.com',modelId:'one'}]};
    return original.call(this,name,parent,...args);
  };
  try {
    const api = require('../src/main/capabilityOverrides');
    const local = {type:'local',modelId:'/models/one.gguf'};
    const cloud = {type:'cloud',provider:'cloud',model:'one'};
    api.saveOverrides(local,{image:true,video:false,audio:null});
    api.saveOverrides(cloud,{audio:true,contextLength:128000});
    assert.deepEqual(api.getOverrides(local),{image:true,video:false});
    assert.deepEqual(api.getOverrides(cloud),{audio:true,contextLength:128000});
    assert.deepEqual(api.getOverrides({type:'local',modelId:'/models/two.gguf'}),{});
    delete require.cache[require.resolve('../src/main/capabilityOverrides')];
    assert.deepEqual(require('../src/main/capabilityOverrides').getOverrides(local),{image:true,video:false});
    assert.deepEqual(api.applyOverrides({image:false,audio:true},{image:true,audio:false}),{image:true,audio:false});
    assert.throws(() => api.saveOverrides(local,{image:'yes'}),/Invalid/);
    assert.throws(() => api.saveOverrides(local,{contextLength:128000}),/Invalid/);
    for (const contextLength of [0,-1,1.5,'128000']) assert.throws(() => api.saveOverrides(cloud,{contextLength}),/Invalid/);
    api.saveOverrides(local,{});
    assert.deepEqual(api.getOverrides(local),{});
    assert.deepEqual(api.getOverrides(cloud),{audio:true,contextLength:128000});
  } finally { Module._load = original; db.close(); }
});
test('explicit media overrides pass unknown runtime detection and can block supported inputs', async () => {
  const {createMediaGuardedFetch} = require('../src/main/modelCapabilities');
  let overrides = {image:true,video:true,audio:true};
  let sent = 0;
  const guarded = createMediaGuardedFetch(async url => {
    if (url.endsWith('/props')) return {ok:false,status:404};
    sent++; return {ok:true};
  }, () => overrides);
  const request = {body:JSON.stringify({messages:[{content:[{type:'image_url'},{type:'input_video'},{type:'input_audio'}]}]})};
  await guarded('http://127.0.0.1:8080/v1/chat/completions',request);
  assert.equal(sent,1);
  overrides.image = false;
  await assert.rejects(guarded('http://127.0.0.1:8080/v1/chat/completions',request),/does not support image/);
  assert.equal(sent,1);
});
