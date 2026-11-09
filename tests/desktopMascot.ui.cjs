// Run with env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/desktopMascot.ui.cjs
const {app,BrowserWindow,screen,ipcMain}=require('electron');
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const {createDesktopMascot}=require('../src/main/desktopMascot');
const {DEFAULT_MASCOT_SETTINGS}=require('../src/lib/mascotSettings.cjs');
function virtualPointer(x,y,button=0){
 const script=`import ctypes,sys
x=ctypes.CDLL('libX11.so.6'); t=ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype=ctypes.c_void_p
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p]; x.XDefaultRootWindow.restype=ctypes.c_ulong
x.XWarpPointer.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_int,ctypes.c_int,ctypes.c_uint,ctypes.c_uint,ctypes.c_int,ctypes.c_int]
x.XFlush.argtypes=[ctypes.c_void_p];x.XCloseDisplay.argtypes=[ctypes.c_void_p]
t.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
d=x.XOpenDisplay(None)
if not d: raise Exception('Virtual display unavailable')
x.XWarpPointer(d,0,x.XDefaultRootWindow(d),0,0,0,0,int(sys.argv[1]),int(sys.argv[2]))
if int(sys.argv[3]): t.XTestFakeButtonEvent(d,1,int(sys.argv[3])>0,0)
x.XFlush(d);x.XCloseDisplay(d)`;
 require('node:child_process').execFileSync('python3',['-c',script,String(Math.round(x)),String(Math.round(y)),String(button)]);
}
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 let main,other,service,server;
 const development=process.argv.includes('--dev');
 const wait=(ms=180)=>new Promise(resolve=>setTimeout(resolve,ms));
 try{
 if(development){const {createServer}=await import('vite');server=await createServer({configFile:path.resolve('vite.config.mjs'),server:{port:5189,strictPort:false}});await server.listen()}
 const fixture=path.join(__dirname,'fixtures/desktopMascotMain.html');
 main=new BrowserWindow({show:true,width:500,height:400,webPreferences:{preload:path.join(__dirname,'../src/preload.js'),sandbox:true,contextIsolation:true}});
 await main.loadFile(fixture);
 let saved={...DEFAULT_MASCOT_SETTINGS,size:128};
 service=createDesktopMascot({mainWindow:main,isDev:development,rendererURL:server?.resolvedUrls.local[0],root:path.resolve(__dirname,'..'),mainURL:pathToFileURL(fixture).href,getSettings:()=>({mascot:saved}),saveSettings:value=>{saved=value.mascot}});
 const pet=service.window,errors=[];
 pet.webContents.on('console-message',(_event,level,message)=>{if(level>=3){errors.push(message);console.error('Companion renderer:',message)}});
 if(pet.webContents.isLoading())await new Promise(resolve=>pet.webContents.once('did-finish-load',resolve));
 for(let attempt=0;attempt<100;attempt++){
   if(await pet.webContents.executeJavaScript("!!document.querySelector('.desktop-mascot-art img')?.naturalHeight"))break;
   await wait(100);
 }

 assert.equal(pet.isAlwaysOnTop(),true);assert.equal(pet.isVisible(),true);assert.equal(pet.getParentWindow(),null);
 assert.equal(await pet.webContents.executeJavaScript('typeof window.api'),'undefined');
 assert.ok(await pet.webContents.executeJavaScript("document.querySelector('.desktop-mascot-art img')?.naturalHeight>0"),'Desktop mascot decodes assets through file URL');
 assert.equal(await pet.webContents.executeJavaScript("getComputedStyle(document.body).backgroundColor"),'rgba(0, 0, 0, 0)');
 assert.equal(await pet.webContents.executeJavaScript("!!document.querySelector('[aria-label=\"Mascot menu\"]')"),false,'No persistent three-dot control');
 // An unrelated application window can be active while this independent window is visible.
 other=new BrowserWindow({show:true,width:1000,height:700});await other.loadURL('data:text/html,<body style="background:%23252c39;color:white;font:24px sans-serif">Another application</body>');other.setBounds(screen.getPrimaryDisplay().workArea);other.focus();main.minimize();await wait();assert.equal(pet.isVisible(),true);
 await main.webContents.executeJavaScript(`
 window.desktopMascotMain.onPrompt(event=>{
   window.receivedDesktopPrompt=event;
   window.desktopMascotMain.acknowledge({id:event.id});
   window.desktopMascotMain.publish({activity:{state:'working',id:event.id,busy:true,reply:'Streaming response from the existing agent.'}});
 });
 window.desktopMascotMain.target({id:'foreground',ready:true,name:'Selected local model'});
 `);
 await wait();
 // Actual cursor movement on the virtual desktop reveals the hover-only control.
 const initialLayout=service.state().layout;
 virtualPointer(initialLayout.bounds.x+initialLayout.art.x+initialLayout.size/2,initialLayout.bounds.y+initialLayout.art.y+initialLayout.size/2);
 await wait(250);
 assert.ok(await pet.webContents.executeJavaScript("!!document.querySelector('[aria-label=\"Write a prompt\"]')"),'Native hover reveals compose control');
 // Focus exposes the same control as pointer hover, without relying on a pixel click.
 pet.focus();await wait();await pet.webContents.executeJavaScript("document.querySelector('.desktop-mascot-art').focus()");await wait();
 await pet.webContents.executeJavaScript("document.querySelector('[aria-label=\"Write a prompt\"]').click()");await wait();
 assert.ok(await pet.webContents.executeJavaScript("!!document.querySelector('[aria-label=\"Prompt Continuum\"]')"));
 await pet.webContents.executeJavaScript(`(()=>{const t=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Hello from the desktop');t.dispatchEvent(new Event('input',{bubbles:true}))})()`);await wait();
 await pet.webContents.executeJavaScript("document.querySelector('[aria-label=\"Send prompt\"]').click()");await wait(400);
 assert.equal(await main.webContents.executeJavaScript('window.receivedDesktopPrompt.text'),'Hello from the desktop');
 assert.equal(service.state().activity.state,'working');
 assert.equal(await pet.webContents.executeJavaScript("document.querySelector('.desktop-mascot-art img').dataset.state"),'working');
 assert.equal(await pet.webContents.executeJavaScript("getComputedStyle(document.querySelector('.desktop-mascot-reply')).fontSize"),'10px');
 assert.match(await pet.webContents.executeJavaScript("document.querySelector('.desktop-mascot-reply').textContent"),/Streaming response/);
 await main.webContents.executeJavaScript("window.desktopMascotMain.publish({activity:{state:'confused',id:'approval',busy:true,reply:''}})");await wait();
 assert.ok(await pet.webContents.executeJavaScript("!!document.querySelector('.desktop-mascot-attention')"));
 await pet.webContents.executeJavaScript("document.querySelector('.desktop-mascot-attention').click()");await wait();assert.equal(main.isMinimized(),false);
 // Resolve attention, then exercise native captured-pointer dragging across the desktop.
 await main.webContents.executeJavaScript("window.desktopMascotMain.publish({activity:{state:'idle',id:'resolved',busy:false,reply:''}})");await wait();
 await other.webContents.executeJavaScript('window.desktopClicks=0;window.addEventListener("click",()=>window.desktopClicks++)');
 const transparent=service.state().layout.bounds;
 virtualPointer(transparent.x+2,transparent.y+2);await wait(200);
 virtualPointer(transparent.x+2,transparent.y+2,1);virtualPointer(transparent.x+2,transparent.y+2,-1);await wait();
 assert.equal(await other.webContents.executeJavaScript('window.desktopClicks'),1,'Transparent companion space passes clicks to the other application');
 // Xvfb has no window manager to honor EWMH stacking during input injection.
 // Click-through was verified above; isolate the window for native drag capture.
 other.hide();main.hide();pet.show();pet.focus();await wait();
 await pet.webContents.executeJavaScript("window.pointerEvents=[];for(const t of ['pointerdown','pointermove','pointerup'])document.addEventListener(t,e=>window.pointerEvents.push([t,e.screenX,e.screenY]))");
 const before=service.state().layout;
 const cx=before.bounds.x+before.art.x+before.size/2,cy=before.bounds.y+before.art.y+before.size/2;
 virtualPointer(cx,cy);await wait();virtualPointer(cx,cy,1);await wait(80);
 virtualPointer(cx-20,cy-10);await wait(120);virtualPointer(cx-130,cy-80);await wait(150);virtualPointer(cx-130,cy-80,-1);await wait(200);
 assert.ok(saved.desktopPosition,'Native drag persists desktop coordinates');
 assert.ok(service.state().layout.anchor.x<before.anchor.x-50,'Native drag moves the desktop window');
 const dropped=saved.desktopPosition.x;pet.webContents.sendInputEvent({type:'keyDown',keyCode:'Left'});await wait();assert.ok(saved.desktopPosition.x<dropped,'Focused arrow key moves the desktop mascot');
 await main.webContents.executeJavaScript("window.desktopMascotMain.publish({activity:{state:'happy',id:'finished',busy:false,reply:'A compact response. The full conversation stays in Continuum.'}})");await wait();
 await fs.writeFile('/tmp/continuum-desktop-mascot.png',(await pet.webContents.capturePage()).toPNG());
 // The companion cannot use the main renderer's publish capability.
 let rejected=false;try{await pet.webContents.executeJavaScript("window.mascotAPI.submit('still busy')")}catch{rejected=true}
 // Close hides instead of quitting; settings in the main window can re-enable it.
 pet.close();await wait();assert.equal(saved.enabled,false);assert.equal(pet.isVisible(),false);
 assert.deepEqual(errors,[]);console.log('Desktop companion UI passed: independent always-on-top window, transparent background, hover/focus composer, minimized-main prompt routing, working/reply/approval UI, 10px responses, position persistence and hide. Screenshot: /tmp/continuum-desktop-mascot.png');
 }catch(error){console.error(error);if(service){console.error('Companion state:',JSON.stringify(service.state()));console.error('Pointer events:',await service.window.webContents.executeJavaScript('JSON.stringify(window.pointerEvents)'));console.error(await service.window.webContents.executeJavaScript('document.body.innerHTML.slice(0,1500)'));}app.exitCode=1}
 finally{service?.dispose();main?.destroy();other?.destroy();await server?.close();app.exit(app.exitCode||0)}
});
