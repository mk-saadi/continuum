const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'network-settings-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await require('esbuild').build({ stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import WorkspaceNetworkSettings from './src/components/WorkspaceNetworkSettings.jsx';
      window.api = {
        getConfig: async()=>({workspaceNetwork:{version:2,policy:'isolated'}}),
        getWorkspaceNetworkStatus: async()=>({available:false,blockers:['Release qualification incomplete'],disclosure:'May reach host-local and private LAN services.'}),
        setWorkspaceNetwork: async()=>{throw Error('Must not activate');}
      };
      createRoot(document.getElementById('root')).render(<WorkspaceNetworkSettings/>);
    `, loader:'jsx', resolveDir:process.cwd() }, bundle:true, outfile:path.join(directory,'fixture.js') });
    await fs.writeFile(path.join(directory,'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory,'index.html'));
    await window.webContents.executeJavaScript(`(async()=>{
      for(let i=0;i<40&&!document.querySelector('select');i++)await new Promise(r=>setTimeout(r,50));
      await new Promise(r=>setTimeout(r,100));
      const select=document.querySelector('select');
      if(select.value!=='isolated')throw Error('Legacy default');
      if(!select.querySelector('[value=trusted_development]').disabled)throw Error('Unavailable choice enabled');
      if(!document.body.textContent.includes('host-local and private LAN'))throw Error('Missing disclosure');
      if(!document.body.textContent.includes('Release qualification incomplete'))throw Error('Missing diagnostic');
    })()`);
    console.log('PASS networking settings: isolated default, disabled unqualified trust, disclosure and diagnostic');
  } finally { window.destroy(); await fs.rm(directory,{recursive:true,force:true}); }
}).then(()=>app.quit(), error=>{console.error(error);app.exit(1);});
