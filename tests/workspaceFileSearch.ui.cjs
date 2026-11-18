const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app.on('window-all-closed', event => event.preventDefault());
app.whenReady().then(async () => {
 const directory = await fs.mkdtemp('/tmp/workspace-switching-');
 const win = new BrowserWindow({ show: true, webPreferences: { sandbox: true } });
 try {
  await require('esbuild').build({ stdin: { contents: `
   import React from 'react'; import {createRoot} from 'react-dom/client';
   import {WorkspaceFiles} from './src/components/WorkspaceFiles.jsx';
   window.searchRequests = [];
   window.api = {
    getWorkspaceRepository: async () => ({available:false}),
    getWorkspaceGitStatus: async () => ({connected:false}),
    listWorkspaceDirectory: async () => ({items:[{name:'src',path:'src',directory:true}]}),
    searchWorkspaceFiles: (project, query) => new Promise(resolve => window.searchRequests.push({query,resolve}))
   };
   function Demo() { const [selected,setSelected]=React.useState(null); return <WorkspaceFiles projectId="test" projectName="Example project" selectedPath={selected} onSelect={path => {window.openedFile=path;setSelected(path)}} />; }
   createRoot(document.getElementById('root')).render(<Demo/>);
  `, resolveDir:process.cwd(), loader:'jsx'}, bundle:true, outfile:directory+'/app.js', loader:{'.css':'empty'}});
  const styles = (await fs.readdir('dist/assets')).filter(file => file.endsWith('.css'));
  await fs.writeFile(directory+'/style.css', (await Promise.all(styles.map(file=>fs.readFile('dist/assets/'+file,'utf8')))).join('\n'));
  await fs.writeFile(directory+'/index.html','<html data-theme="dark"><link rel="stylesheet" href="style.css"><body style="margin:0;background:var(--surface);color:var(--text-primary)"><div id="root" style="height:100vh;width:325px"></div><script src="app.js"></script></body></html>');
  await win.loadFile(directory+'/index.html');
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(await win.webContents.executeJavaScript(`(async()=>{
   const wait=(ms=60)=>new Promise(r=>setTimeout(r,ms));
   const check=(v,m)=>{if(!v)throw Error(m)};
   check(!document.querySelector('input[type=search]'),'search hidden by default');
   const toggle=document.querySelector('[aria-label="Toggle file search"]');
   check(toggle.previousElementSibling?.getAttribute('aria-label')==='Refresh files' || toggle.compareDocumentPosition(document.querySelector('[aria-label="Refresh files"]')) & Node.DOCUMENT_POSITION_PRECEDING,'toggle follows refresh');
   toggle.click(); await wait();
   const input=document.querySelector('input[type=search]'); check(document.activeElement===input,'opening focuses search');
   check(window.searchRequests.length===0,'empty search does not scan');
   const type=text=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,text); input.dispatchEvent(new Event('input',{bubbles:true}));};
   type('app'); type('app.jsx'); await wait(300); check(window.searchRequests.length===0,'search waits before running'); await wait(260); check(window.searchRequests.length===1,'search runs after 500 ms');
   type('readme'); await wait(560);
   window.searchRequests[1].resolve({items:[{name:'README.md',path:'docs/README.md'}]}); await wait();
   window.searchRequests[0].resolve({items:[{name:'app.jsx',path:'src/app.jsx'}]}); await wait();
   check(!document.querySelector('[aria-label="src/app.jsx"]'),'late results ignored');
   document.querySelector('[aria-label="docs/README.md"]').click(); await wait(); check(window.openedFile==='docs/README.md','result opens correct file');
   type(''); await wait(); check(document.querySelector('[aria-label="Workspace files"]'),'clearing restores tree');
   input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await wait();
   check(!document.querySelector('input[type=search]')&&document.activeElement===toggle,'escape closes and returns focus');
   toggle.click(); await wait(); check(document.querySelector('input[type=search]').value==='','reopened search starts empty');
   toggle.click(); await wait(); check(!document.querySelector('input[type=search]'),'toggle closes');
   return true;
  })()`),true);
  await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Toggle file search"]').click()`);
  await new Promise(resolve=>setTimeout(resolve,100));
  await fs.writeFile('/tmp/workspace-file-search.png',(await win.webContents.capturePage()).toPNG());
  console.log('File search toggle, debounce, stale results, selection, clear and Escape passed.');
 } finally { win.destroy(); await fs.rm(directory,{recursive:true,force:true}); }
}).then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)});
