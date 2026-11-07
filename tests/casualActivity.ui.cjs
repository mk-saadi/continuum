const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'casual-activity-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import ChatMessage from './src/components/ChatMessage.jsx';
      const steps=[{id:'thought',type:'thought',content:'Private activity text'},
      {id:'failure',type:'tool_call',toolName:'web_search',status:'error',error:'Search unavailable',args:{query:'pricing'}},
      {id:'success',type:'tool_call',toolName:'web_search',status:'complete',result:'Found results'},
      {id:'question',type:'tool_call',toolName:'ask_user',status:'complete',args:{question:'Which option?'},result:'First'}];
      window.render=(streaming=false,mode='casual')=>createRootOnce.render(<ChatMessage message={{id:'test',role:'assistant',content:'Here is your answer.',streaming,executionSteps:steps}} mode={mode} interactive={false}/>);
      const createRootOnce=createRoot(document.getElementById('root')); window.render();
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(process.cwd(), 'dist/assets');
    await fs.copyFile(path.join(assets, (await fs.readdir(assets)).find(name => name.endsWith('.css'))), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="fixture.css"><style>:root{--surface:#242424;--subtle-border:#454545;--error:#ff0000}</style><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async()=>{
      const tick=()=>new Promise(r=>setTimeout(r,80)); await tick();
      const check=(v,m)=>{if(!v)throw Error(m)};
      const radio=document.createElement('input'); radio.type='radio'; radio.className='appearance-radio'; document.body.append(radio);
      for(const appearance of ['flat','aero']) {
        document.documentElement.dataset.appearance=appearance;
        check(getComputedStyle(radio).appearance==='none','Radio must use themed indicator: '+appearance);
        check(getComputedStyle(radio).backgroundColor==='rgba(0, 0, 0, 0)','Unchecked radio must not be white');
        radio.checked=false; check(getComputedStyle(radio,'::before').transform.includes('0, 0, 0, 0'),'Unchecked radio has no dot');
        radio.checked=true; check(getComputedStyle(radio,'::before').transform==='matrix(1, 0, 0, 1, 0, 0)','Checked radio has visible dot');
      }
      radio.remove(); delete document.documentElement.dataset.appearance;
      const host=document.createElement('div'); host.dataset.chatMode='casual';
      host.innerHTML='<div class="aero-chat-composer sk-composer focus-within:ring-2! focus-within:ring-[var(--accent)]/50!" style="padding:12px;width:400px"><textarea></textarea></div>';
      document.body.append(host);
      const composer=host.firstElementChild;
      for(const mode of ['casual','workspace']) {
      host.dataset.chatMode=mode;
      for(const appearance of ['aero','flat','skeu']) {
        document.documentElement.dataset.appearance=appearance;
        document.documentElement.dataset.style=appearance;
        composer.querySelector('textarea').blur();
        const before=composer.getBoundingClientRect();
        composer.querySelector('textarea').focus();
        const after=composer.getBoundingClientRect();
        check(before.width===after.width&&before.height===after.height&&before.y===after.y,'Focus must preserve composer geometry: '+appearance);
        check(getComputedStyle(composer).boxShadow.includes('2px'),'Focus ring must render: '+appearance);
      }
      }
      host.remove(); delete document.documentElement.dataset.appearance; delete document.documentElement.dataset.style;

      let activity=document.querySelector('[aria-label="Reply activity"]');
      check(activity&&!activity.open,'Activity must start collapsed');
      check(!document.querySelector('[aria-label="Activity details"]'),'Collapsed logs must not mount');
      check(activity.textContent.includes('2 actions')&&activity.textContent.includes('1 unsuccessful'),'Summary counts');
      check(document.body.textContent.includes('Here is your answer.')&&document.body.textContent.includes('Which option?'),'Answer and question remain visible');
      activity.querySelector('summary').click(); await tick();
      check(document.querySelector('[aria-label="Activity details"]'),'Disclosure opens');
      check(document.body.textContent.includes('Web search'),'Tools available in details');
      const thought=document.querySelector('[aria-label="Activity details"] details');
      check(getComputedStyle(thought).backgroundColor==='rgba(0, 0, 0, 0)','Collapsed thought is transparent');
      thought.querySelector('summary').click(); await tick();
      check(getComputedStyle(thought).backgroundColor!=='rgba(0, 0, 0, 0)','Expanded thought has background');
      const tool=document.querySelector('[data-tool="web_search"]');
      check(getComputedStyle(tool).backgroundColor==='rgba(0, 0, 0, 0)','Collapsed tool has no background');
      check(getComputedStyle(tool).borderTopColor==='rgba(0, 0, 0, 0)','Failed tool has transparent border');
      tool.querySelector('button[aria-expanded]').click(); await tick();
      check(getComputedStyle(tool).backgroundColor==='rgb(36, 36, 36)','Expanded tool shows surface background');
      check(getComputedStyle(tool).borderTopColor==='rgba(0, 0, 0, 0)','Expanded failure keeps transparent border');
      window.render(true); await tick(); check(document.querySelector('[aria-label="Reply activity"]').open,'Expansion persists during streaming');
      window.render(false,'workspace'); await tick();
      check(!document.querySelector('[aria-label="Reply activity"]')&&document.querySelector('.message-execution-timeline'),'Workspace retains timeline');
    })()`);
    console.log('Casual disclosure, failure counts, visible questions, streaming state, and workspace isolation passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
