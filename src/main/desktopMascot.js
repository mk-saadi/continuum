'use strict';
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {randomUUID} = require('node:crypto');
const {anchorFor,saveAnchor,layoutFor,hitLayout} = require('./desktopMascotGeometry.js');
const {normalizeMascotSettings} = require('../lib/mascotSettings.cjs');

// This window has no chat/filesystem bridge. Prompts are delivered to the trusted
// main renderer, which executes its existing selected-chat send path.
function createDesktopMascot({mainWindow,isDev,root, getSettings,saveSettings,mainURL,rendererURL,electron=require('electron')}) {
    const {BrowserWindow,ipcMain,screen,Menu} = electron;
    let win, disposed=false, drag=null, target=null, pending=null, receiptTimer=null, publishTimer=null;
    let settings=normalizeMascotSettings(getSettings().mascot);
    let activity={state:'idle',id:'idle',busy:false,reply:''};
    let dialogOpen=false;
    let panel={editor:false,response:false}, hovered=false, direction='left', layout;
    const channels=[];
    const entry=pathToFileURL(path.join(root,'dist','index.html')).href;
    const expectedMain=mainURL || (isDev?'http://localhost:5173/':entry);
    const expectedDesktop=isDev?new URL('?desktopMascot=1',rendererURL||'http://localhost:5173/').href:entry+'?desktopMascot=1';
    function displays(){const primary=screen.getPrimaryDisplay();return screen.getAllDisplays().map(d=>({...d,primary:d.id===primary.id}))}
    let anchor=anchorFor(displays(),settings.desktopPosition,settings.size);
    function alive(w){return w&&!w.isDestroyed()}
    function sendMain(channel,data){if(alive(mainWindow))mainWindow.webContents.send(channel,data)}
    function authorized(event,desktop){
        const owner=desktop?win:mainWindow;
        if(!alive(owner)||event.sender!==owner.webContents||event.senderFrame!==owner.webContents.mainFrame)throw Error('Unauthorized mascot sender.');
        const actual=new URL(event.senderFrame.url),expected=new URL(desktop?expectedDesktop:expectedMain);
        actual.hash='';
        if(actual.href!==expected.href)throw Error('Unauthorized mascot document.');
    }
    function state(){return {settings,activity,target,submitting:!!pending,hovered,direction,layout,panel}}
    function broadcast(){if(alive(win))win.webContents.send('mascot:state',state())}
    function save(patch){const next=normalizeMascotSettings({...settings,...patch});saveSettings({mascot:next});settings=next;sendMain('mascot:settings',settings);reconcile();return settings}
    function nativeAction(fn){return()=>{try{return fn()}catch(error){activity={state:'error-nan',id:randomUUID(),busy:false,reply:error.message};panel.response=true;reconcile()}}}
    function reconcile(){
        if(!alive(win))return;
        anchor.display=displays().find(d=>d.id===anchor.display.id)||screen.getPrimaryDisplay();
        layout=layoutFor(anchor.display,anchor,settings.size,panel);anchor={...anchor,...layout.anchor};
        const center=anchor.x+layout.size/2-(anchor.display.workArea.x+anchor.display.workArea.width/2);
        if(settings.automaticFacing){if(center < -24)direction='right';else if(center>24)direction='left'}else direction=settings.facing;
        const current=win.getBounds?.();
        if(!current || ['x','y','width','height'].some(key=>current[key]!==layout.bounds[key]))win.setBounds(layout.bounds,false);
        const blocked=mainWindow.isFocused?.() && (dialogOpen || activity.state==='confused');
        if(settings.enabled&&!blocked){if(!win.isVisible())win.showInactive()}else win.hide();
        broadcast();
    }
    function showMain(settingsTab=false){
        if(!alive(mainWindow))return;
        if(mainWindow.isMinimized())mainWindow.restore();
        mainWindow.show();mainWindow.focus();
        if(settingsTab)sendMain('mascot:open-settings');
    }
    function rejectPending(message){if(!pending)return;clearTimeout(receiptTimer);pending=null;activity={state:'error-nan',id:randomUUID(),busy:false,reply:message};panel.response=true;reconcile()}
    function handle(channel,desktop,fn){ipcMain.handle(channel,(event,value)=>{authorized(event,desktop);return fn(value)});channels.push(channel)}
    win=new BrowserWindow({width:settings.size+16,height:settings.size+40,show:false,frame:false,transparent:true,
        backgroundColor:'#00000000',hasShadow:false,alwaysOnTop:true,skipTaskbar:true,resizable:false,maximizable:false,
        fullscreenable:false,acceptFirstMouse:true,webPreferences:{preload:path.join(root,'src','mascotPreload.js'),
            contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    win.setAlwaysOnTop(true,'floating');
    win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{if(url!==expectedDesktop)event.preventDefault()});
    win.webContents.on('did-finish-load',()=>{win.webContents.setZoomFactor(1);reconcile()});
    win.on('close',event=>{if(!disposed){event.preventDefault();nativeAction(()=>save({enabled:false}))()}});
    handle('mascot:get-state',true,()=>state());
    handle('mascot:set-panel',true,value=>{
        panel={editor:!!value?.editor,response:!!value?.response};reconcile();
        if(panel.editor){win.setIgnoreMouseEvents(false);win.focus()}
        return state();
    });
    handle('mascot:submit',true,value=>{
        if(typeof value!=='string'||!value.trim()||value.length>32000)throw Error('Enter a prompt up to 32,000 characters.');
        if(!target?.ready)throw Error(target?.reason||'Open a chat and choose a model in Continuum first.');
        if(pending||activity.busy)throw Error('The agent is already working.');
        pending={id:randomUUID(),targetId:target.id};
        activity={state:'thinking',id:pending.id,busy:true,reply:''};panel={editor:false,response:false};
        sendMain('mascot:prompt',{...pending,text:value.trim()});
        receiptTimer=setTimeout(()=>rejectPending('Continuum did not accept this prompt. Open the main window and try again.'),8000);
        reconcile();return {accepted:true};
    });
    handle('mascot:drag-start',true,()=>{if(settings.locked)return false;drag={cursor:screen.getCursorScreenPoint(),x:anchor.x,y:anchor.y};return true});
    handle('mascot:drag-move',true,()=>{
        if(!drag)return;
        const cursor=screen.getCursorScreenPoint();anchor={...anchor,display:screen.getDisplayNearestPoint(cursor),x:drag.x+cursor.x-drag.cursor.x,y:drag.y+cursor.y-drag.cursor.y};reconcile();
    });
    handle('mascot:drag-end',true,()=>{if(!drag)return;drag=null;return save({desktopPosition:saveAnchor(anchor.display,anchor,layout.size)})});
    handle('mascot:keyboard-move',true,value=>{
        if(settings.locked)return;
        if(!value||!['left','right','up','down'].includes(value.direction))return;
        const step=value.large?32:8;
        anchor.x+=value.direction==='left'?-step:value.direction==='right'?step:0;
        anchor.y+=value.direction==='up'?-step:value.direction==='down'?step:0;
        reconcile();return save({desktopPosition:saveAnchor(anchor.display,anchor,layout.size)});
    });
    handle('mascot:open-main',true,()=>showMain());
    handle('mascot:cancel',true,()=>sendMain('mascot:cancel-request',{targetId:target?.id}));
    handle('mascot:context-menu',true,()=>Menu.buildFromTemplate([
        {label:'Open Continuum',click:()=>showMain()},
        {label:'Mascot settings',click:()=>showMain(true)},
        {type:'separator'},
        {label:'Lock position',type:'checkbox',checked:settings.locked,click:nativeAction(()=>save({locked:!settings.locked}))},
        {label:'Reset position',click:nativeAction(()=>{anchor=anchorFor(displays(),null,settings.size);save({desktopPosition:null})})},
        {label:'Hide mascot',click:nativeAction(()=>save({enabled:false}))},
    ]).popup({window:win}));
    handle('mascot:main-publish',false,value=>{
        if(!value||typeof value!=='object')return;
        if(typeof value.dialogOpen==='boolean')dialogOpen=value.dialogOpen;
        if(value.settings){const next=normalizeMascotSettings(value.settings);const changed=JSON.stringify(settings.desktopPosition)!==JSON.stringify(next.desktopPosition);settings=next;if(changed)anchor=anchorFor(displays(),settings.desktopPosition,settings.size)}
        if(value.activity&&typeof value.activity.state==='string'){
            activity={state:value.activity.state,id:String(value.activity.id||'idle'),busy:!!value.activity.busy,reply:String(value.activity.reply||'').slice(0,12000)};
            if(activity.reply || ['confused','error-xx'].includes(activity.state))panel.response=true;
        }
        if(!publishTimer)publishTimer=setTimeout(()=>{publishTimer=null;reconcile()},40);
    });
    handle('mascot:main-target',false,value=>{
        if(value?.id!==target?.id&&pending)rejectPending('The selected chat changed. Send the prompt again.');
        target=value&&typeof value.id==='string'?{id:value.id,ready:!!value.ready,reason:String(value.reason||''),name:String(value.name||'Selected chat')}:null;
        broadcast();
    });
    handle('mascot:main-ack',false,value=>{
        if(!pending||value?.id!==pending.id)return;
        if(value.error){rejectPending(String(value.error));return}
        clearTimeout(receiptTimer);pending=null;broadcast();
    });
    // Transparent parts of an expanded window pass input to the app underneath.
    // Native cursor polling also works when Linux does not forward ignored events.
    const pointerTimer=setInterval(()=>{
        if(!alive(win)||!settings.enabled||!win.isVisible()||!layout)return;
        const cursor=screen.getCursorScreenPoint(),over=hitLayout(layout,cursor);
        win.setIgnoreMouseEvents(!drag&&!over);
        if(hovered!==over){hovered=over;broadcast()}
    },75);
    const displayChange=()=>{anchor=anchorFor(displays(),saveAnchor(anchor.display,anchor,layout?.size||settings.size),settings.size);reconcile()};
    for(const event of ['display-added','display-removed','display-metrics-changed'])screen.on(event,displayChange);
    mainWindow.on('focus',reconcile);mainWindow.on('blur',reconcile);
    reconcile();
    if(isDev)win.loadURL(expectedDesktop);else win.loadFile(path.join(root,'dist','index.html'),{query:{desktopMascot:'1'}});
    return {get window(){return win},state,reconcile,dispose(){
        disposed=true;mainWindow.removeListener('focus',reconcile);mainWindow.removeListener('blur',reconcile);clearInterval(pointerTimer);clearTimeout(receiptTimer);clearTimeout(publishTimer);
        for(const event of ['display-added','display-removed','display-metrics-changed'])screen.removeListener(event,displayChange);
        for(const channel of channels)ipcMain.removeHandler(channel);
        if(alive(win))win.destroy();
    }};
}
module.exports={createDesktopMascot};
