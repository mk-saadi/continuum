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
      window.api={getChildTranscript:async()=>({found:true,status:window.status,model:'Test model',turns:[],activity:[{type:'fetch',url:'https://example.com',chars:1200}],turnCount:1,liveProgress:window.progress,result:window.status==='complete'?{text:'Done'}:null})};
      const root=createRoot(document.getElementById('root'));
      window.renderCard=(legacy,status)=>{window.status=status;root.render(React.createElement(legacy?ToolCallBlock:ToolEventCard,{step:{id:'call',type:'tool_call',toolName:'spawn_sub_agent',childSessionId:'child',status,args:{task:'Inspect files'},result:'Done'}}));};
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(process.cwd(), 'dist/assets');
    await fs.copyFile(path.join(assets, (await fs.readdir(assets)).find(name => name.startsWith('index-') && name.endsWith('.css'))), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,80));
      const expandTool=()=>{const toggle=document.querySelector('button[aria-expanded="false"]');if(toggle)toggle.click();};
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
        const collapsed=activityButton();if(collapsed&&!collapsed.closest('[hidden]'))throw Error('Activity button outside collapsed tool details');
        expandTool();await wait();
        const button=activityButton();if(!button||button.closest('[hidden]'))throw Error('Expanded tool lacks activity button');
        button.click();await wait();if(!document.querySelector('dialog')?.open)throw Error('Cannot reopen modal');
        document.querySelector('[aria-label="Close sub-agent activity"]').click();await wait();
      }
      window.renderCard(false,'running');await wait();activityButton().click();await wait();
      const poll=()=>new Promise(r=>setTimeout(r,600));
      const pane=document.querySelector('[aria-label="Sub-agent conversation"]');
      if(!pane)throw Error('Missing shared conversation viewport');
      for(const type of ['thinking','responding']) {
        window.progress={type,text:'BEGIN_FULL_TEXT '+Array.from({length:100},(_,i)=>'Line '+i+' '+ 'x'.repeat(50)).join('\\n')+' END_FULL_TEXT'};await poll();
        if(type==='thinking') {
          const thought=[...pane.querySelectorAll('summary')].find(el=>el.textContent.includes('Thought'));
          if(!thought)throw Error('Missing shared thought disclosure');
          thought.click();await wait();
          window.progress={type,text:window.progress.text+'\\nMore text'};await poll();
        }
        if(!pane.textContent.includes('BEGIN_FULL_TEXT')||!pane.textContent.includes('END_FULL_TEXT'))throw Error(type+' text was clipped');
        if(pane.scrollHeight<=pane.clientHeight)throw Error(type+' conversation does not overflow');
        if(pane.scrollHeight-pane.scrollTop-pane.clientHeight>2)throw Error('Conversation did not follow text');
        pane.scrollTop=0;pane.dispatchEvent(new Event('scroll',{bubbles:true}));await wait();
        window.progress={type,text:window.progress.text+'\\nAdditional text'};await poll();
        if(pane.scrollTop!==0)throw Error('Conversation interrupted reading older text');
        const jump=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Jump to latest'));
        if(!jump)throw Error('Missing resume control');jump.click();await wait();
        if(pane.scrollHeight-pane.scrollTop-pane.clientHeight>2)throw Error('Conversation did not jump to latest');
      }
      window.progress=null;window.status='completed';await poll();
      window.api.getChildTranscript=async()=>({found:true,status:'completed',model:'Test model',turns:[],activity:[{type:'fetch',url:'https://example.com',chars:1200},{type:'thought',text:'Read the page and compare the examples.'}],result:{text:'## Findings\\n\\nA **complete** answer with formatted text.\\n\\n~~~js\\nconst example = true;\\n~~~'}});await poll();
      if(!pane.querySelector('h2')||!pane.querySelector('strong')||!pane.querySelector('pre'))throw Error('Answer lacks shared Markdown rendering');
      for(const label of ['Assigned task','Final answer','Activity history','Usage and tools','Conversation details']) {
        if(pane.textContent.includes(label))throw Error('Old section remains: '+label);
      }
      const partialAnswer='Analysis unavailable because the page requires JavaScript.';
      window.api.getChildTranscript=async()=>({found:true,status:'partial',turns:[],activity:[],result:{text:partialAnswer},error:partialAnswer});await poll();
      if(pane.querySelector('[role="alert"]'))throw Error('Partial answer duplicated as a runtime error');
      if((pane.textContent.match(/Analysis unavailable because the page requires JavaScript/g)||[]).length!==1)throw Error('Partial answer must appear once');


    })()`);
    await window.setSize(1200, 900);
    await fs.writeFile('/tmp/subagent-chat-modal.png', (await window.webContents.capturePage()).toPNG());
    console.log('Both tool cards retain open modals on success/error and allow reopening after completion.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
