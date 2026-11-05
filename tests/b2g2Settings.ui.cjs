const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const profile = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'network-settings-profile-'));
app.setPath('userData', profile);
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
        getConfig: async()=>({workspaceNetwork:{version:3,policy:'standard_outbound'}}),
        getWorkspaceNetworkStatus: async()=>({available:false,message:'Networking resources or runtime prerequisites for this build are missing, unsupported or failed verification.',blockers:['Missing pinned resources'],disclosure:'Standard outbound disclosure text.',effectivePolicy:'standard_outbound'}),
        setWorkspaceNetwork: async()=>{window.networkMutations=(window.networkMutations||0)+1;throw Error('Must not activate');}
      };
      createRoot(document.getElementById('root')).render(<WorkspaceNetworkSettings/>);
    `, loader:'jsx', resolveDir:process.cwd() }, bundle:true, outfile:path.join(directory,'fixture.js') });
    await fs.writeFile(path.join(directory,'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory,'index.html'));
    await window.webContents.executeJavaScript(`(async()=>{
      for(let i=0;i<40&&!document.querySelector('select');i++)await new Promise(r=>setTimeout(r,50));
      await new Promise(r=>setTimeout(r,100));
      const select=document.querySelector('select');
      if(select.value!=='standard_outbound')throw Error('Default tier must be standard outbound');
      if(!select.querySelector('[value=trusted_development]').disabled)throw Error('Unavailable elevated choice enabled');
      document.querySelector('button[aria-haspopup=listbox]').click();
      await new Promise(r=>setTimeout(r,50));
      const option=[...document.querySelectorAll('button[role=option]')].find(el=>el.textContent.includes('Elevated networking'));
      if(!option?.disabled)throw Error('Custom dropdown lost the disabled state');
      option.click();await new Promise(r=>setTimeout(r,50));
      if(window.networkMutations)throw Error('Unavailable option invoked IPC');
      if(select.value!=='standard_outbound')throw Error('Unavailable option changed effective display');
      if(!document.body.textContent.includes('host-local and private network services'))throw Error('Missing elevated disclosure');
      if(!document.body.textContent.includes('Networking resources or runtime prerequisites'))throw Error('Missing diagnostic');
      if(!document.body.textContent.includes('Standard outbound internet is enabled'))throw Error('Missing standard outbound description');
    })()`);
    console.log('PASS networking settings: standard outbound default, disabled unqualified elevated choice, disclosure and diagnostic');
  } finally { window.destroy(); await fs.rm(directory,{recursive:true,force:true}); await fs.rm(profile,{recursive:true,force:true}); }
}).then(()=>app.quit(), error=>{console.error(error);app.exit(1);});
