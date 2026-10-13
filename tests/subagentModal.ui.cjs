const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-modal-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import ToolEventCard from './src/components/chat/ToolEventCard';
      import ToolCallBlock from './src/components/ToolCallBlock';
      window.status='running';
      window.api={getChildTranscript:async()=>({found:true,status:window.status,turns:[],activity:[],turnCount:1,liveProgress:window.progress,result:window.status==='complete'?{text:'Done'}:null})};
      const root=createRoot(document.getElementById('root'));
      window.renderCard=(legacy,status)=>{window.status=status;root.render(React.createElement(legacy?ToolCallBlock:ToolEventCard,{step:{id:'call',type:'tool_call',toolName:'spawn_sub_agent',childSessionId:'child',status,args:{task:'Inspect files'},result:'Done'}}));};
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(process.cwd(), 'dist/assets');
    await fs.copyFile(path.join(assets, (await fs.readdir(assets)).find(name => name.endsWith('.css'))), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,80));
      const activityButton=()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Show sub-agent activity'));
      for(const legacy of [false,true]) {
        window.renderCard(legacy,'running');await wait();activityButton().click();await wait();
        const dialog=document.querySelector('dialog');if(!dialog?.open)throw Error('Modal did not open');
        for(const status of ['complete','error']) {
          window.renderCard(legacy,status);await wait();
          if(document.querySelector('dialog')!==dialog||!dialog.open)throw Error('Modal closed on '+status);
        }
        document.querySelector('[aria-label="Close sub-agent activity"]').click();await wait();
        window.renderCard(legacy,'complete');await wait();
        const button=activityButton();if(!button||button.closest('[hidden]'))throw Error('Completed button hidden');
        button.click();await wait();if(!document.querySelector('dialog')?.open)throw Error('Cannot reopen modal');
        document.querySelector('[aria-label="Close sub-agent activity"]').click();await wait();
      }
      window.renderCard(false,'running');await wait();activityButton().click();await wait();
      const poll=()=>new Promise(r=>setTimeout(r,600));
      for(const [type,label] of [['thinking','Thinking'],['responding','Output']]) {
        window.progress={type,text:Array.from({length:100},(_,i)=>'Line '+i).join('\\n')};await poll();
        const pane=document.querySelector('[aria-label="'+label+' text"]');
        if(!pane||pane.scrollHeight<=pane.clientHeight)throw Error(label+' pane does not overflow');
        if(pane.scrollHeight-pane.scrollTop-pane.clientHeight>2)throw Error(label+' did not follow initial text');
        window.progress={type,text:window.progress.text+'\\nMore text'};await poll();
        if(pane.scrollHeight-pane.scrollTop-pane.clientHeight>2)throw Error(label+' did not follow new text');
        pane.scrollTop=0;pane.dispatchEvent(new Event('scroll',{bubbles:true}));await wait();
        window.progress={type,text:window.progress.text+'\\nAdditional text'};await poll();
        if(pane.scrollTop!==0)throw Error(label+' interrupted reading older text');
        const jump=[...pane.closest('section').querySelectorAll('button')].find(b=>b.textContent.includes('Jump to latest'));
        if(!jump)throw Error(label+' lacks resume control');jump.click();await wait();
        if(pane.scrollHeight-pane.scrollTop-pane.clientHeight>2)throw Error(label+' did not jump to latest');
      }
    })()`);
    console.log('Both tool cards retain open modals on success/error and allow reopening after completion.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
