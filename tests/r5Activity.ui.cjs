const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'r5-activity-'));
 app.setPath('userData', directory);
 const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
 try {
  await require('esbuild').build({ stdin: { contents: `
   import React from 'react'; import {createRoot} from 'react-dom/client';
   import ToolEventCard from './src/components/chat/ToolEventCard.jsx';
   const probe={id:'probe',type:'tool_call',toolName:'run_tests',status:'complete',args:{command:'printf SYNTAX_OK'},result:{success:true,status:'inconclusive',executionStatus:'completed',verificationState:'inconclusive',exitCode:0,stdout:'SYNTAX_OK'}};
   const fail={...probe,id:'failure',status:'error',result:{...probe.result,success:false,status:'failed',verificationState:'failed',stdout:'not ok 1 - assertion'}};
   createRoot(document.getElementById('root')).render(<><div id="probe"><ToolEventCard step={probe}/></div><div id="failure"><ToolEventCard step={fail}/></div></>);
  `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js') });
  await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
  await window.loadFile(path.join(directory, 'index.html'));
  await window.webContents.executeJavaScript(`(async()=>{
   for(let i=0;i<100&&!document.querySelector('#probe');i++)await new Promise(r=>setTimeout(r,20));
   const probe=document.querySelector('#probe').textContent;
   const failed=document.querySelector('#failure').textContent;
   if(!probe.includes('Verification inconclusive')||probe.includes('Tool call failed'))throw Error(probe);
   if(!failed.includes('Tests failed'))throw Error(failed);
  })()`);
  console.log('R5 activity UI: inconclusive command and failed assertion rendered distinctly.');
 } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1);});
