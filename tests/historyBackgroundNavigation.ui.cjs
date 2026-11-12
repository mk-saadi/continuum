// Run under Electron with xvfb-run, as with the other UI suites.
if (!process.versions.electron) {
  require('node:test')('background history navigation requires Electron', t => t.skip());
} else {
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.disableHardwareAcceleration();
app.on('window-all-closed', event => event.preventDefault());
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp('/tmp/background-navigation-');
  const window = new BrowserWindow({show:false,webPreferences:{sandbox:true}});
  try {
    await require('esbuild').build({stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
      import React,{useEffect,useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {TabProvider,useTabs} from './src/context/TabContext.jsx';
      import Sidebar from './src/components/Sidebar.jsx';
      import TabBar from './src/components/TabBar.jsx';
      localStorage.removeItem('continuum_open_tabs');
      window.cancelled=[]; window.ticks={}; window.unmounted=[];
      window.chatAPI={cancelSession:async id=>window.cancelled.push(id)};
      const sessions=[{id:'casual',title:'Other casual chat',project_id:null,model_id:'model'}, {id:'workspace',title:'Other workspace chat',project_id:'p',model_id:'model'}];
      function Pane({tab,active}) {
        useEffect(()=>{const timer=setInterval(()=>{window.ticks[tab.sessionId]=(window.ticks[tab.sessionId]||0)+1;},20);return()=>{clearInterval(timer);window.unmounted.push(tab.sessionId);};},[tab.sessionId]);
        return <div hidden={!active}>{tab.sessionId}</div>;
      }
      function Fixture(){
        const tabs=useTabs();window.tabsApi=tabs;
        const [workspace,setWorkspace]=useState(false);window.setWorkspace=setWorkspace;
        return <><TabBar /><Sidebar isWorkspace={workspace} chatProjectId={workspace?'p':null} projects={[{id:'p',name:'Project'}]} groups={[{folder_name:'Chats',sessions}]} disabled activeId={tabs.activeTab.sessionId} onLoad={id=>tabs.openSessionTab(sessions.find(session=>session.id===id))} onNew={()=>{}} />{tabs.tabs.map(tab=><Pane key={tab.id} tab={tab} active={tab.id===tabs.activeTabId}/>)}</>;
      }
      createRoot(document.getElementById('root')).render(<TabProvider><Fixture/></TabProvider>);
    `},bundle:true,outfile:path.join(directory,'app.js'),loader:{'.css':'empty'}});
    await fs.writeFile(path.join(directory,'index.html'),'<div id="root"></div><script src="app.js"></script>');
    await window.loadFile(path.join(directory,'index.html'));
    await window.webContents.executeJavaScript(`(async()=>{
      const tick=()=>new Promise(resolve=>setTimeout(resolve,80));
      const check=(value,message)=>{if(!value)throw new Error(message);};
      await tick();
      const original=window.tabsApi.activeTab;
      window.tabsApi.updateTab(original.id,{status:'generating'});await tick();
      const before=window.ticks[original.sessionId];
      const casual=document.querySelector('[data-session-id="casual"] > button');
      check(casual && !casual.disabled,'casual chat selectable during generation');casual.click();await tick();
      check(window.tabsApi.activeTab.sessionId==='casual','casual chat opens independently');
      window.setWorkspace(true);await tick();
      const workspace=document.querySelector('[data-session-id="workspace"] > button');
      check(workspace && !workspace.disabled,'workspace chat selectable during generation');workspace.click();await tick();
      check(window.tabsApi.activeTab.sessionId==='workspace','workspace chat opens independently');
      check(window.ticks[original.sessionId]>before,'original pane continues background activity');
      check(window.tabsApi.tabs.find(tab=>tab.id===original.id).status==='generating','original run status preserved');
      check(!window.cancelled.length && !window.unmounted.includes(original.sessionId),'navigation neither cancels nor unmounts original run');
      window.tabsApi.openSessionTab({id:'casual',title:'Other casual chat',model_id:'different'});await tick();
      check(window.tabsApi.tabs.length===3,'reopening an existing conversation does not duplicate its tab');
      window.tabsApi.activateTab(original.id);await tick();
      check(window.tabsApi.activeTab.sessionId===original.sessionId,'return to original running conversation');
      const otherTab = window.tabsApi.tabs.find(tab=>tab.sessionId==='casual');
      document.querySelector('[data-tab-id="'+otherTab.id+'"]').click();await tick();
      check(window.tabsApi.activeTabId===otherTab.id,'clicking tab housing activates tab');
      const closing = window.tabsApi.tabs.find(tab=>tab.sessionId==='workspace');
      document.querySelector('[data-tab-id="'+closing.id+'"] button[aria-label^="Close "]').click();await tick();
      check(window.tabsApi.activeTabId===otherTab.id && !window.tabsApi.tabs.some(tab=>tab.id===closing.id),'close icon closes without activating tab');

    })().catch(error=>{throw new Error(error.stack)})`);
    console.log('Casual/workspace history stays clickable; original pane stays mounted and active; existing tabs reused without cancellation.');
  } finally {window.destroy();await fs.rm(directory,{recursive:true,force:true});}
}).then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1);});
}
