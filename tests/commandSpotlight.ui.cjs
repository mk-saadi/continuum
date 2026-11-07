// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/commandSpotlight.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');
const profile = require('node:fs').mkdtempSync(path.join(os.tmpdir(),'spotlight-profile-'));
app.setPath('userData',profile);
app.on('window-all-closed',()=>{});
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'spotlight-ui-'));
  const browser = new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true}});
  try {
    await esbuild.build({entryPoints:['tests/fixtures/commandSpotlight.jsx'],bundle:true,outfile:path.join(dir,'fixture.js'),define:{'process.env.NODE_ENV':'"test"'}});
    const css=(await fs.readdir('dist/assets')).find(file=>file.endsWith('.css'));
    await fs.writeFile(path.join(dir,'index.html'),`<link rel="stylesheet" href="${pathToFileURL(path.resolve('dist/assets',css)).href}"><div id="root"></div><script src="fixture.js"></script>`);
    await browser.loadFile(path.join(dir,'index.html'));
    await browser.webContents.executeJavaScript(`(async()=>{
      const tick=(ms=50)=>new Promise(r=>setTimeout(r,ms));
      const check=(yes,message)=>{if(!yes)throw new Error(message)};
      const until=async(fn,message)=>{for(let i=0;i<100;i++){if(fn())return;await tick()}throw new Error(message)};
      const key=(key,patch={})=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...patch}));
      const type=text=>{const input=document.querySelector('[role="combobox"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));};
      const open=async()=>{document.querySelector('#origin').focus();key('P',{ctrlKey:true,shiftKey:true});await until(()=>document.querySelector('[role="combobox"]'),'palette did not open')};
      const command=async name=>{type(name);await tick();key('Enter');await tick()};
      await until(()=>window.state,'fixture not ready');
      document.querySelector('#origin').focus();
      key('[',{ctrlKey:true});await tick();check(window.state.left,'left shortcut');
      key(']',{ctrlKey:true});await tick();check(window.state.right,'right shortcut');
      key('.',{ctrlKey:true});await tick();check(window.state.settingsOpen,'settings shortcut');
      document.querySelector('#dismiss').click();await tick();key('m',{ctrlKey:true});await tick();check(window.state.modelSelectorOpen,'model shortcut');
      document.querySelector('#dismiss').click();await tick();
      await open();check(document.activeElement.getAttribute('role')==='combobox','focus search on open');
      key('Tab',{shiftKey:true});await tick();check(document.querySelector('[role="dialog"]').contains(document.activeElement),'trap keyboard focus');document.querySelector('[role="combobox"]').focus();
      key('ArrowDown');await tick();check(document.querySelector('[aria-selected="true"]').textContent.includes('Search chats'),'arrow navigation');
      key('Escape');await tick();check(document.activeElement.id==='origin','restore focus');
      await open();await command('search workspaces');type('Beta');await tick();key('Enter');await tick();check(window.state.tab.projectId==='beta'&&window.state.tab.view==='project','workspace navigation');
      await open();await command('enable MCP');await until(()=>document.querySelector('[role="option"]')?.textContent.includes('files'),'disabled server list');key('Enter');await tick();check(window.calls.some(call=>call[0]==='mcp'&&call[1]==='files'&&call[2]===true),'enable server');check(document.querySelector('[role="dialog"]'),'MCP menu stays open');key('Escape');await tick();
      await command('disable MCP');await until(()=>document.querySelector('[role="option"]')?.textContent.includes('browser'),'enabled server list');window.failMcp=true;key('Enter');await until(()=>document.querySelector('[role="alert"]'),'show MCP failure');check(document.querySelector('[role="option"]').textContent.includes('browser'),'failed toggle remains available');window.failMcp=false;key('Escape');await tick();key('Escape');await tick();
      await open();await command('change UI style');type('Flat');await tick();key('Enter');await tick();check(document.documentElement.dataset.appearance==='flat','appearance selection');
      await open();await command('change theme');type('Light');await tick();key('Enter');await tick();check(localStorage.getItem('theme')==='light','theme selection');
      await open();await command('search chats');await until(()=>document.querySelector('[role="option"]')?.textContent.includes('Saved conversation'),'chat list');key('Enter');await tick();check(window.state.tab.sessionId==='saved','open saved chat');
      await open();await command('search chat messages');type('slow');await tick(250);type('newest');await tick(700);check(document.querySelector('[role="option"]').textContent.includes('newest'),'discard stale async results');
      document.querySelector('button.underline').click();await tick();check(window.calls.some(call=>call[0]==='search'&&call[2]===42),'message cursor pagination');
      key('Enter');await tick();check(window.state.tab.navigationTarget?.messageId===42,'navigate to message identity');
      await open();await command('unload model');key('Enter');await tick();check(window.calls.some(call=>call[0]==='unload'&&call[1]==='running'),'unload model');key('Escape');await tick();key('Escape');await tick();
      await open();await command('scheduled tasks');check(window.state.tab.view==='tasks','tasks navigation');
      await open();await command('load model');type('Local model');await tick();key('Enter');await until(()=>document.querySelector('dialog[open]'),'model settings dialog');
      const beforeSidebar = window.state.left;key('[',{ctrlKey:true});await tick();check(window.state.left===beforeSidebar,'suppress app shortcuts inside model dialog');
      document.querySelector('dialog form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await until(()=>window.calls.some(call=>call[0]==='load'&&call[1]==='local-model'),'launch chosen model');
      await until(()=>!document.querySelector('dialog[open]'),'close loaded model dialog');
    })()`);
    browser.show();
    await browser.webContents.executeJavaScript(`document.querySelector('#origin').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'P',ctrlKey:true,shiftKey:true,bubbles:true}));`);
    await new Promise(resolve=>setTimeout(resolve,400));
    const visible = await browser.webContents.executeJavaScript(`!!document.querySelector('[role="dialog"]')`);
    if (!visible) throw new Error('Spotlight not visible for visual inspection');
    for (const mode of ['flat','aero','skeu']) {
      const material = await browser.webContents.executeJavaScript(`window.setSpotlightAppearance(${JSON.stringify(mode)});new Promise(resolve=>setTimeout(()=>{const panel=document.querySelector('[aria-label="Command spotlight"]');const styles=getComputedStyle(panel);const row=getComputedStyle(panel.querySelector('[aria-selected="true"]'));const inactive=getComputedStyle(panel.querySelector('[aria-selected="false"]'));resolve({inactiveImage:inactive.backgroundImage,inactiveShadow:inactive.boxShadow,inactiveFill:inactive.backgroundColor,image:styles.backgroundImage,blur:styles.backdropFilter,shadow:styles.boxShadow,rowImage:row.backgroundImage})},100))`);
      if (material.inactiveImage!=='none'||material.inactiveShadow!=='none'||material.inactiveFill!=='rgba(0, 0, 0, 0)') throw new Error('Inactive rows must be plain: '+JSON.stringify(material));
      if (mode==='flat' && (material.image!=='none'||material.blur!=='none'||material.shadow!=='none')) throw new Error('Flat spotlight must remove glass, gradients and elevation: '+JSON.stringify(material));
      if (mode==='aero' && (material.image==='none'||material.blur==='none'||material.shadow==='none')) throw new Error('Aero spotlight must use glass material: '+JSON.stringify(material));
      if (mode==='skeu' && (material.image==='none'||material.blur!=='none'||material.rowImage==='none')) throw new Error('Skeu spotlight must use opaque textured surfaces and buttons: '+JSON.stringify(material));
      await fs.writeFile('/tmp/continuum-spotlight-'+mode+'.png',(await browser.capturePage()).toPNG());
    }
    console.log('Spotlight shortcuts, navigation, focus, themes/styles, MCP errors, async search and pagination passed.');
  } finally {browser.destroy();await fs.rm(dir,{recursive:true,force:true});}
}).then(()=>{require('node:fs').rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});app.quit();}).catch(error=>{console.error(error);app.exit(1)});
