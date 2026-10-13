const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-toolbar-'));
  const window = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import MessageActions from './src/components/MessageActions'; import ChatMessage from './src/components/ChatMessage'; const message={id:1,role:'assistant',content:'reply',created_at:'2026-10-12T02:58:00Z',variants:[{content:'first'},{content:'reply',stats:{tokens_per_sec:26.7,total_tokens:6633,duration:5.5}}],active_variant_index:1}; createRoot(document.getElementById('root')).render(<><ChatMessage message={message} /><MessageActions message={message} onSelectReplyVariant={(msg,index)=>{window.selectedIndex=index; window.selectedId=msg.id}} onDelete={()=>{}} onBranch={()=>{}} onError={()=>{}} /></>);`, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(process.cwd(), 'dist/assets');
    await fs.copyFile(path.join(assets, (await fs.readdir(assets)).find(name => name.endsWith('.css'))), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async()=>{await new Promise(r=>setTimeout(r,80));if(document.querySelectorAll('[aria-label="Previous reply version"]').length!==1)throw Error('Reply navigation duplicated');const metadata=document.querySelector('[aria-label="Reply metadata"]');const time=metadata.querySelector('time');const stats=metadata.querySelector('[aria-label="Generation statistics"]');if(!time||!stats||document.querySelectorAll('time').length!==1)throw Error('Timestamp is not consolidated');const tr=time.getBoundingClientRect(),sr=stats.getBoundingClientRect();if(Math.abs(tr.y+tr.height/2-sr.y-sr.height/2)>1)throw Error('Timestamp and stats not aligned');const group=document.querySelector('[aria-label="Message actions"]'); const buttons=[...group.querySelectorAll('button')];const centers=buttons.map(b=>{const r=b.getBoundingClientRect();return r.y+r.height/2});if(Math.max(...centers)-Math.min(...centers)>1)throw Error('Controls are not aligned'); const previous=group.querySelector('[aria-label="Previous reply version"]'); const next=group.querySelector('[aria-label="Next reply version"]'); if(!next.disabled || previous.disabled)throw Error('Boundary buttons incorrect'); previous.click();if(window.selectedIndex!==0 || window.selectedId!==1)throw Error('Original navigation arguments not preserved');if(!group.textContent.includes('2 / 2'))throw Error('Version count missing');})()`);
    console.log('Reply counter and message actions align on one row; navigation and boundaries passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
