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
      window.memoryPalace = {
        getBackgroundCommands: async () => [{command_id:'cmd_a',command_summary:'npm run build',status:'running',notification_state:'pending'}],
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
    })()`);
    console.log('Background command Activity UI: 7 checks passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
