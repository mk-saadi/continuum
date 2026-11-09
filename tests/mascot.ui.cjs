// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/mascot.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    let win, server;
    const development = process.argv.includes('--dev');
    try {
        const { build, createServer } = await import('vite');
        if (development) {
            server = await createServer({ configFile: path.resolve('vite.config.mjs'), server: { port: 0, strictPort: false } });
            await server.listen();
        } else await build({ configFile: path.resolve('vite.config.mjs'), build: { outDir: '/tmp/continuum-mascot-ui', rollupOptions: { input: path.resolve('tests/fixtures/mascot.html') } }, logLevel: 'warn' });
        win = new BrowserWindow({ show: true, width: 1100, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false, partition: `mascot-ui-${Date.now()}` } });
        const errors = [];
        win.webContents.on('console-message', (_e, _level, message) => { if (message.includes('Uncaught'))
            errors.push(message); });
        if (development) await win.loadURL(server.resolvedUrls.local[0] + 'tests/fixtures/mascot.html');
        else await win.loadFile('/tmp/continuum-mascot-ui/tests/fixtures/mascot.html');
        await win.webContents.executeJavaScript(`(async()=>{
 const wait=(ms=100)=>new Promise(r=>setTimeout(r,ms)),check=(v,m)=>{if(!v)throw Error(m)};
 await wait(500);const api=window.mascotTest;
 let mascot=document.querySelector('.continuum-mascot');check(mascot,'Mascot enabled by default');check(mascot.querySelector('img')?.naturalHeight>0,'Bundled idle WebP decodes');
 await api.update({animation:'reduced',hue:90});await wait();check(document.querySelector('.continuum-mascot img').dataset.playback==='static','Actual PNG used for reduced motion');
 check(getComputedStyle(document.querySelector('.continuum-mascot img')).filter.includes('90deg'),'Hue applied to artwork');
 const button=mascot.querySelector('button');button.focus();button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await wait();check(api.get().settings.position.x<1,'Keyboard moves and persists');
 await api.update({position:{x:0,y:.5}});await wait();check(getComputedStyle(document.querySelector('.continuum-mascot img')).transform.includes('-1'),'Left side faces right');
 api.select('foreground');api.event('foreground','r1',{type:'begin'});api.event('foreground','r1',{type:'tool',id:1,toolName:'execute_command',status:'running'});await wait();check(document.querySelector('.continuum-mascot img').dataset.state==='terminal','Terminal activity');check(!getComputedStyle(document.querySelector('.continuum-mascot img')).transform.includes('-1'),'Text symbols remain unmirrored');
 api.attention('foreground',true);await wait();check(document.querySelector('.continuum-mascot img').dataset.state==='confused','Attention preempts execution');
 await api.update({animation:'full'});await wait();api.attention('foreground',false);api.event('foreground','r1',{type:'end',outcome:'completed'});await wait(5500);check(document.querySelector('.continuum-mascot img').dataset.part==='hold','Reaction enters happy hold');
 await api.update({animation:'reduced',sleep:1});api.select(null);await wait();
 const realNow=Date.now;Date.now=()=>realNow()+61000;await wait(1200);check(document.querySelector('.continuum-mascot img').dataset.state==='sleepy','Idle inactivity enters sleep');window.dispatchEvent(new KeyboardEvent('keydown',{key:'a'}));await wait();check(document.querySelector('.continuum-mascot img').dataset.state==='idle','Input wakes mascot immediately');Date.now=realNow;await api.update({animation:'full'});await wait();
 const preview=document.querySelector('[aria-label="Preview expression"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(preview,'laughing');preview.dispatchEvent(new Event('change',{bubbles:true}));await wait();check(document.querySelectorAll('img').length===2,'Independent preview');document.querySelector('#toggle-preview').click();await wait();check(document.querySelectorAll('img').length===1,'Leaving preview cleans up');
 await api.update({size:240,position:{x:1,y:1}});await wait();
 const dialog=document.querySelector('#approval');dialog.showModal();const r=dialog.getBoundingClientRect();check(dialog.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),'Approval is above mascot in native top layer');dialog.close();
 api.modals.openSettings('mascot');await wait();check(!document.querySelector('.continuum-mascot'),'Settings have clear access above overlay');api.modals.closeSettings();await wait();
 })()`);
        // System mode follows the browser's operating-system motion preference.
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
        await win.webContents.executeJavaScript("window.mascotTest.update({animation:'system'})");
        await new Promise(resolve=>setTimeout(resolve,200));
        assert.equal(await win.webContents.executeJavaScript("document.querySelector('.continuum-mascot img').dataset.playback"),'static');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
        await new Promise(resolve=>setTimeout(resolve,200));
        assert.equal(await win.webContents.executeJavaScript("document.querySelector('.continuum-mascot img').dataset.playback"),'animated');
        win.webContents.debugger.detach();
        // Native pointer events exercise capture and threshold.
        let rect = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.continuum-mascot button').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 100, y: 200 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: 100, y: 200, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 150));
        assert.ok(await win.webContents.executeJavaScript('window.mascotTest.get().settings.position.x<0.2'), 'Native drag persists left position');
        win.setSize(420, 400);
        await new Promise(r => setTimeout(r, 150));
        assert.ok(await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.continuum-mascot').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1})()`), 'Resize clamps mascot');
        await fs.writeFile('/tmp/continuum-mascot-ui.png', (await win.webContents.capturePage()).toPNG());
        // Reload is a renderer restart; backing database restart is separately tested.
        await win.reload();
        await new Promise(r => setTimeout(r, 400));
        assert.equal(await win.webContents.executeJavaScript('window.mascotTest.get().settings.size'), 240);
        // Force all animated assets to fail; the static PNG fallback must decode.
        win.webContents.session.webRequest.onBeforeRequest({ urls: ['file:///*', 'http://*/*'] }, (details, cb) => cb({ cancel: details.url.endsWith('.webp') }));
        await win.reload();
        await new Promise(r => setTimeout(r, 700));
        assert.ok(await win.webContents.executeJavaScript("(()=>{const img=document.querySelector('.continuum-mascot img');return img?.naturalHeight>0&&img.dataset.playback==='static'})()"), 'Missing animated asset falls back to static PNG');
        await win.webContents.executeJavaScript(`window.mascotTest.update({enabled:false})`);
        await new Promise(r => setTimeout(r, 100));
        assert.equal(await win.webContents.executeJavaScript("!!document.querySelector('.continuum-mascot')"), false);
        await win.reload();
        await new Promise(r => setTimeout(r, 250));
        assert.equal(await win.webContents.executeJavaScript("!!document.querySelector('.continuum-mascot')"), false);
        assert.deepEqual(errors, []);
        console.log('Mascot UI: asset decode, keyboard, facing, native drag, resize, reaction/hold, preview cleanup, persistence and hide passed. Screenshot: /tmp/continuum-mascot-ui.png');
    }
    catch (e) {
        console.error(e);
        app.exitCode = 1;
    }
    finally {
        win?.destroy();
        await server?.close();
        app.exit(app.exitCode || 0);
    }
});
