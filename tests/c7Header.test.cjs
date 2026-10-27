const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),path=require('node:path');
const esbuild=require('esbuild');
test('C7 rendered header uses selected live input for label, progress and tooltip',async()=>{
 const {selectContextOccupancy}=await import('../src/lib/contextDisplay.mjs');
 const bundled=esbuild.buildSync({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import Header from './src/components/main-app/Header.jsx';export default palace=>renderToStaticMarkup(<Header palace={palace}/>);`,loader:'jsx',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom/server']});
 const m=new Module(path.resolve('tests/c7-render.cjs'),module);m.filename=path.resolve('tests/c7-render.cjs');m.paths=module.paths;m._compile(bundled.outputFiles[0].text,m.filename);
 const live={sessionId:'chat',modelId:'qwen',promptTokens:66125,method:'server-template-tokenizer',telemetry:{peakPromptTokens:66125}};
 const base={prepared:31247,limit:74112,sessionId:'chat',modelId:'qwen'};
 for(const running of [true,false]){
  const selected=selectContextOccupancy({...base,live:running?live:null});
  const html=m.exports.default({contextTokens:selected.tokens,preparedContextTokens:31247,limit:74112,contextMode:running?'Live':'Prepared',liveTelemetry:running?live:null,turnTelemetry:live.telemetry});
  assert.match(html,running?/66\.1k \/ 74\.1k.*Live/:/31\.2k \/ 74\.1k.*Prepared/);
  assert.match(html,running?/aria-valuenow="89"/:/aria-valuenow="42"/);
  assert.match(html,/Prepared next request: 31,247/);
 }
});
