const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app.on('window-all-closed', event => event.preventDefault());
app.whenReady().then(async () => {
 const directory = await fs.mkdtemp('/tmp/workspace-switching-');
 const win = new BrowserWindow({ show: true, webPreferences: { sandbox: true } });
 try {
  await require('esbuild').build({stdin:{contents:`
   import React from 'react'; import {createRoot} from 'react-dom/client';
   import WorkspaceChanges from './src/components/WorkspaceChanges.jsx';
   window.diffReads=0; window.activeReads=0; window.peakReads=0;
   window.api={
    getRecoveryChangedFiles:async()=>({files:Array.from({length:37},(_,i)=>({path:'file'+i+'.jsx',added:150,deleted:0})),branch:'main'}),
    getRecoveryFileDiff:async(path)=>{window.diffReads++;window.activeReads++;window.peakReads=Math.max(window.peakReads,window.activeReads);await new Promise(r=>setTimeout(r,300));window.activeReads--;return {text:'@@ -1,1 +1,150 @@'+String.fromCharCode(10)+Array.from({length:150},(_,i)=>'+const value'+i+' = <div className="example">Hello</div>;').join(String.fromCharCode(10))};}
   };
   function Demo(){const [open,setOpen]=React.useState(true);window.setReviewOpen=setOpen;return open&&<WorkspaceChanges sessionId="test" refresh={0} wrap={false} onOpenFile={()=>{}}/>;}
   createRoot(document.getElementById('root')).render(<Demo/>);
  `,resolveDir:process.cwd(),loader:'jsx'},bundle:true,outfile:directory+'/app.js',loader:{'.css':'empty'}});
  const styles = (await fs.readdir('dist/assets')).filter(file => file.endsWith('.css'));
  await fs.writeFile(directory+'/style.css', (await Promise.all(styles.map(file=>fs.readFile('dist/assets/'+file,'utf8')))).join('\n'));
  await fs.writeFile(directory+'/index.html','<html data-theme="dark"><link rel="stylesheet" href="style.css"><body style="margin:0;background:var(--surface);color:var(--text-primary)"><div id="root" style="display:flex;height:100vh;width:720px"></div><script src="app.js"></script></body></html>');
  await win.loadFile(directory+'/index.html');
  await new Promise(resolve=>setTimeout(resolve,200));
  await new Promise(resolve=>setTimeout(resolve,3000));
  console.log(JSON.stringify(await win.webContents.executeJavaScript(`({reads:window.diffReads,peak:window.peakReads,rows:document.querySelectorAll('[data-change-line]').length,nodes:document.querySelectorAll('*').length})`)));
   assert.ok(await win.webContents.executeJavaScript('window.diffReads < 10'), 'offscreen diffs are not eagerly read');
   assert.ok(await win.webContents.executeJavaScript('window.peakReads <= 2'), 'Git concurrency bounded');
   assert.ok(await win.webContents.executeJavaScript("!!document.querySelector('[data-change-line] .token')"), 'syntax highlighting remains enabled');
   const reads=await win.webContents.executeJavaScript('window.diffReads');
   await new Promise(resolve=>setTimeout(resolve,500));
   assert.equal(await win.webContents.executeJavaScript('window.diffReads'),reads,'idle view stops fetching');
   await win.webContents.executeJavaScript(`const scroll = document.querySelector('[aria-label="Workspace changes"] > div:last-child'); scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;`);
   await new Promise(resolve=>setTimeout(resolve,700));
   assert.ok(await win.webContents.executeJavaScript('window.diffReads')>reads,'scroll loads newly visible files');
   await win.webContents.executeJavaScript('window.setReviewOpen(false)');
   await new Promise(resolve=>setTimeout(resolve,100));
   assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('[data-change-line]').length"),0,'close releases rows');
 } finally { win.destroy(); await fs.rm(directory,{recursive:true,force:true}); }
}).then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)});
