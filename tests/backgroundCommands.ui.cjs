// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/backgroundCommands.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'background-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await require('esbuild').build({ stdin: { contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import BackgroundCommandCard from './src/components/chat/BackgroundCommandCard.jsx';
      Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.copied=value;}}});
      window.previewEnabled=false; window.previewState={available:true,status:'not_created'};
      window.memoryPalace = {
        getCommandPreview: async()=>window.previewEnabled?window.previewState:{available:false,status:'unavailable'},
        createCommandPreview: async(sessionId,commandId,port)=>{if(window.failPreview)throw Error('Server not ready');window.created={sessionId,commandId,port};return window.previewState={available:true,status:'ready',url:'http://127.0.0.1:1234/'};},
        openCommandPreview: async(sessionId,commandId)=>{window.opened={sessionId,commandId};},
        getBackgroundCommands: async () => window.fixtureRecords || [{command_id:'cmd_a',command_summary:'npm run build',status:'running',notification_state:'pending'}],
        stopBackgroundCommand: async (sessionId, commandId) => {window.stopped={sessionId,commandId};return {command_id:commandId,command_summary:'persistent server',status:'cancelled',reason:'user_stopped',notification_state:'undelivered',survive_run_completion:true};},
        onBackgroundCommand: fn => {window.pushBackground=fn;return ()=>{window.pushBackground=null;};}
      };
      function Fixture(){const [session,setSession]=useState('a');window.switchSession=setSession;return <BackgroundCommandCard sessionId={session}/>;}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js') });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,50));
      const check=(condition,message)=>{if(!condition)throw Error(message);};
      for(let i=0;i<50&&!window.pushBackground;i++)await wait();
      check(document.body.textContent.includes('1 running'),'running count');
      window.pushBackground({sessionId:'other',record:{command_id:'secret',command_summary:'SECRET'}});await wait();
      check(!document.body.textContent.includes('SECRET'),'cross-session event ignored');
      window.pushBackground({sessionId:'a',record:{command_id:'cmd_a',command_summary:'npm run build',status:'completed',exitCode:0,duration_ms:45,notification_state:'queued',stdout:'BUILD_OK'}});await wait();
      check(document.body.textContent.includes('0 running'),'terminal count');
      check(document.body.textContent.includes('Notification: queued'),'queued distinct from informed');
      check(document.body.textContent.includes('BUILD_OK'),'bounded output visible');
      window.pushBackground({sessionId:'a',record:{command_id:'cmd_a',command_summary:'npm run build',status:'completed',notification_state:'delivered'}});await wait();
      check(document.body.textContent.includes('Agent informed'),'delivery visible');
      window.pushBackground({sessionId:'a',record:{command_id:'cmd_b',command_summary:'server',status:'cancelled',notification_state:'undelivered'}});await wait();
      check(document.body.textContent.includes('Notification: undelivered'),'undelivered retained');
      window.fixtureRecords=[{command_id:'cmd_p',command_summary:'persistent server',status:'running',survive_run_completion:true,expires_at:new Date(Date.now()+60000).toISOString(),notification_state:'pending'}];
      window.pushBackground({sessionId:'a',record:{command_id:'cmd_p',command_summary:'persistent server',status:'running',survive_run_completion:true,expires_at:new Date(Date.now()+60000).toISOString(),notification_state:'pending'}});await wait();
      check(document.body.textContent.includes('Persistent')&&document.body.textContent.includes('s remaining'),'persistent lifetime visible');
      check(!document.body.textContent.includes('Create Preview'),'production unavailable hides actions');
      window.previewEnabled=true; await new Promise(r=>setTimeout(r,1100));
      const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
      check(!!button('Create Preview'),'verified fixture enables creation');
      window.failPreview=true; button('Create Preview').click(); await wait();
      check(document.body.textContent.includes('Server not ready'),'creation errors visible');
      window.failPreview=false; button('Create Preview').click(); await wait();
      check(window.created.sessionId==='a'&&window.created.commandId==='cmd_p'&&window.created.port===5173,'minimal scoped creation');
      button('Open Preview').click(); await wait();
      check(window.opened.sessionId==='a'&&window.opened.commandId==='cmd_p','trusted open action');
      button('Copy URL').click(); await wait(); check(window.copied==='http://127.0.0.1:1234/','credential-free verified copy');
      check(!!button('Copy URL')&&document.body.textContent.includes('already authorized browser profile'),'copy authentication caveat');
      const stop=[...document.querySelectorAll('details')].find(d=>d.textContent.includes('persistent server')).querySelector('button');
      stop.click();await wait();
      check(window.stopped.sessionId==='a'&&window.stopped.commandId==='cmd_p','scoped Stop action');
      check(document.body.textContent.includes('user stopped'),'termination reason visible');
    })()`);
    console.log('Background command Activity UI: existing checks and gated preview fixture passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
