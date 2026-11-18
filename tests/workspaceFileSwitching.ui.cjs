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
   import {WorkspaceFilePreview} from './src/components/WorkspaceFiles.jsx';
   window.api = {
    getWorkspaceRepository: async () => ({available:false}),
    readWorkspaceFile: (project, path) => new Promise(resolve => {
     (window.reads ||= []).push({project,path,resolve});
    }),
    writeWorkspaceFile: async (...args) => { window.savedArgs = args; }
   };
   const NativeObserver = window.ResizeObserver;
   window.editorObservers = new Set();
   window.ResizeObserver = class extends NativeObserver {
    observe(node) { window.editorObservers.add(this); super.observe(node); }
    disconnect() { window.editorObservers.delete(this); super.disconnect(); }
   };
   function Demo() {
    const [path,setPath] = React.useState('a.js'); const [project,setProject] = React.useState('one');
    const [mounted,setMounted] = React.useState(true); window.mountPreview = setMounted;
    window.selectFile = setPath; window.selectProject = setProject;
    return mounted && <WorkspaceFilePreview projectId={project} path={path} onClose={() => {}} />;
   }
   createRoot(document.getElementById('root')).render(<Demo/>);
  `, resolveDir: process.cwd(), loader: 'jsx' }, bundle:true, outfile:directory+'/app.js', loader:{'.css':'empty'} });
  await fs.writeFile(directory+'/index.html','<div id="root"></div><script src="app.js"></script>');
  await win.loadFile(directory+'/index.html');
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(await win.webContents.executeJavaScript(`(async()=>{
   const wait=()=>new Promise(r=>setTimeout(r,60));
   const check=(v,m)=>{if(!v)throw Error(m)};
   const text=()=>document.querySelector('.file-code-paint')?.textContent || '';
   const resolve=(project,path,content)=>window.reads.find(r=>r.project===project && r.path===path).resolve({content});
   resolve('one','a.js','const FILE_A = 1;'); await wait(); check(text().includes('FILE_A'),'initial file');
   window.selectFile('b.js'); await wait();
   check(!text().includes('FILE_A'),'old content is hidden while next file loads');
   resolve('one','b.js','const FILE_B = 2;'); await wait();
   check(text().includes('FILE_B')&&!text().includes('FILE_A'),'new file content matches selection');
   window.selectFile('slow.js'); await wait(); window.selectFile('fast.js'); await wait();
   resolve('one','fast.js','const FAST = 3;'); await wait();
   resolve('one','slow.js','const STALE = 4;'); await wait();
   check(text().includes('FAST')&&!text().includes('STALE'),'late reads cannot replace selected file');
   window.selectProject('two'); await wait(); check(!text(),'project switch hides previous content');
   resolve('two','fast.js','const PROJECT_TWO = 5;'); await wait();
   check(text().includes('PROJECT_TWO'),'project identity is respected');
   document.querySelector('[data-file-editor] button').click(); await wait();
   const editor=document.querySelector('textarea');
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,'const MY_DRAFT = 6;');
   editor.dispatchEvent(new Event('input',{bubbles:true})); await wait();
   window.selectFile('other.js'); await wait(); resolve('two','other.js','const OTHER = 7;'); await wait();
   check(text().includes('OTHER')&&!text().includes('MY_DRAFT'),'draft does not leak into another file');
   window.selectFile('fast.js'); await wait(); window.reads.filter(r=>r.project==='two'&&r.path==='fast.js').at(-1).resolve({content:'const PROJECT_TWO = 5;'}); await wait();
   check(document.querySelector('textarea').value.includes('MY_DRAFT'),'own draft restored');
   document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true})); await wait();
   check(window.savedArgs[0]==='two'&&window.savedArgs[1]==='fast.js'&&window.savedArgs[2].includes('MY_DRAFT')&&window.savedArgs[3].includes('PROJECT_TWO'),'save uses correct project path and original content');
   for (let cycle=0; cycle<12; cycle++) {
    window.mountPreview(false); await wait();
    check(window.editorObservers.size === 0, 'unmount releases resize observers');
    check(CSS.highlights.size === 0, 'unmount releases find ranges');
    window.mountPreview(true); await wait();
    window.reads.filter(r=>r.project==='two'&&r.path==='fast.js').at(-1).resolve({content:'const PROJECT_TWO = 5;'}); await wait();
    document.querySelector('[data-file-editor] button').click(); await wait();
    check(window.editorObservers.size === 1, 'one resize observer for active editor');
   }
   return true;
  })()`),true);
  console.log('File switching, late reads, project changes, draft isolation and save target passed.');
 } finally { win.destroy(); await fs.rm(directory,{recursive:true,force:true}); }
}).then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)});
