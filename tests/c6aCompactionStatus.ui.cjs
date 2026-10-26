'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c6a-ui-'));
  app.setPath('userData', dir);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let code = 0;
  try {
    await require('esbuild').build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import ContextPanel from './src/components/ContextPanel';
      import CompactionActivity from './src/components/chat/CompactionActivity';
      const root=createRoot(document.getElementById('root'));
      window.render=event=>root.render(<><ContextPanel sessionId="fixture" active={true}/>{event&&<CompactionActivity event={event}/>}</>);
    ` }, bundle: true, outfile: path.join(dir, 'fixture.js') });
    await fs.writeFile(path.join(dir, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await win.loadFile(path.join(dir, 'index.html'));
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,100));
      window.memoryPalace={getCheckpoint:async()=>({checkpoint:null,evidence:{}}),getCheckpointHistory:async()=>({checkpoints:[]}),
        getBriefs:async()=>({applicable:[],others:[]}),getSessionSummary:async()=>null,
        getArchivedMessages:async()=>({messages:[],total:0,offset:0,limit:20}),onCompressionComplete:cb=>{window.emit=cb;return()=>{};}};
      const text=()=>document.body.textContent;
      window.render();await wait();await wait();
      window.emit({sessionId:'fixture',compressed:false,reason:'owning-request-required',deferred:true});await wait();
      const deferred=!text().includes('Last compression attempt failed');
      window.emit({sessionId:'fixture',compressed:false,reason:'unsupported-completion-claim'});await wait();
      const failure=text().includes('unsupported-completion-claim');
      window.emit({sessionId:'fixture',compressed:false,optionalContinued:true,reason:'invalid-json'});await wait();
      const cleared=!text().includes('Last compression attempt failed');
      window.render({id:'fixture-event',status:'continued',code:'invalid-json',metadata:{continued:true}});await wait();
      const continued=text().includes('Compaction failed; request safely continued')&&text().includes('Agent continued working');
      window.emit({sessionId:'fixture',compressed:true,archivedCount:2,checkpointId:3});await wait();
      const recovered=text().includes('Compressed 2 earlier messages');
      return {deferred,failure,cleared,continued,recovered};
    })()`);
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result)); console.log(JSON.stringify(result));
  } catch (error) { console.error(error); code = 1; }
  finally { win.destroy(); await fs.rm(dir, { recursive: true, force: true }); app.exit(code); }
});
