'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 's1-startup-ui-'));
  app.setPath('userData', directory);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let code = 0;
  try {
    await esbuild.build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React, { StrictMode, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { TabProvider, useTabs } from './src/context/TabContext.jsx';
      import { useMemoryPalace } from './src/components/MemoryPalace.jsx';
      import { CompressionEventsProvider } from './src/context/CompressionEventsContext.jsx';
      const tabs = ['deleted','live'].map(sessionId => ({ id:sessionId,sessionId,modelId:'m',saved:false }));
      localStorage.setItem('continuum_open_tabs',JSON.stringify({tabs,activeTabId:'deleted'}));
      window.calls=0; window.validations=0;
      window.api={getEffectiveSettings:async()=>({effective:{memoryEnabled:true}})};
      window.memoryPalace={
        validateSessionReferences:async()=>{ window.validations++; await new Promise(r=>window.releaseValidation=r); return ['deleted']; },
        getAllSessions:async()=>[{sessions:[{id:'live'}]}],
        getContextUsage:async()=>({}),getCoreMemories:async()=>[],
        measureContext:async(sessionId,modelId)=>{window.calls++;return {sessionId,modelId,tokens:1};}
      };
      function Probe(){const t=useTabs();const [ready,setReady]=useState(false);window.setReady=setReady;window.tabs=t;
        const p=useMemoryPalace('m',{contextLength:32768},t.activeTab.sessionId,undefined,{engineReady:ready,isActive:true});window.palace=p;return null;}
      createRoot(document.getElementById('root')).render(<StrictMode><CompressionEventsProvider><TabProvider><Probe/></TabProvider></CompressionEventsProvider></StrictMode>);
    ` }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"development"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await win.loadFile(path.join(directory, 'index.html'));
    await win.webContents.executeJavaScript(`(async()=>{
      const tick=()=>new Promise(r=>setTimeout(r,30)); const check=(v,m)=>{if(!v)throw Error(m)};
      for(let i=0;i<100&&!window.releaseValidation;i++)await tick();
      check(window.calls===0,'no prevalidation measurement');check(!window.palace,'panes await validation');
      window.releaseValidation();for(let i=0;i<100&&!window.palace;i++)await tick();
      check(window.palace,'StrictMode restoration settles');check(window.tabs.tabs.length===1,'deleted unsaved tab discarded');
      check(window.tabs.activeTab.sessionId==='live','valid restored chat retained');check(window.calls===0,'offline engine never measured');
      window.setReady(true);for(let i=0;i<100&&!window.calls;i++)await tick();
      check(window.calls>0,'ready transition measures valid session');
      window.pending=[];
      window.memoryPalace.measureContext=(sessionId,modelId)=>new Promise(resolve=>window.pending.push({sessionId,modelId,resolve}));
      const old=window.palace.measure();await tick();
      window.palace.setSessionId('second');
      for(let i=0;i<100&&!window.pending.some(p=>p.sessionId==='second');i++)await tick();
      const previous=window.pending.find(p=>p.sessionId==='live');previous.resolve({sessionId:'live',modelId:'m',tokens:999});await old;await tick();
      check(window.palace.measured?.tokens!==999,'obsolete promise cannot publish after switching');
      for(const p of window.pending.filter(p=>p.sessionId==='second'))p.resolve({sessionId:'second',modelId:'m',tokens:42});
      for(let i=0;i<100&&window.palace.measured?.tokens!==42;i++)await tick();
      check(window.palace.measured?.tokens===42,'new session measurement survives unchanged engine identity');
    })()`);
    console.log('S1 StrictMode startup validation, deleted unsaved tabs, offline gating and ready transition passed.');
  } catch (error) { console.error(error); code = 1; }
  finally { win.destroy(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  app.exit(code);
}).catch(error => { console.error(error); app.exit(1); });
