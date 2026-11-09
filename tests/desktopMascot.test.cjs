const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const path=require('node:path'),{pathToFileURL}=require('node:url');
const {anchorFor,saveAnchor,layoutFor,hitLayout}=require('../src/main/desktopMascotGeometry.js');
const {DEFAULT_MASCOT_SETTINGS}=require('../src/lib/mascotSettings.cjs');
const {createDesktopMascot}=require('../src/main/desktopMascot');
const displays=[{id:1,primary:true,workArea:{x:0,y:0,width:1280,height:900}},{id:2,workArea:{x:-1920,y:-100,width:1920,height:1080}}];
test('desktop normalized positions restore on negative-origin displays and unplugging',()=>{
 const a=anchorFor(displays,{displayId:2,x:.3,y:.6},128);assert.equal(a.display.id,2);assert.ok(a.x<0);
 const saved=saveAnchor(a.display,a,128);assert.ok(Math.abs(saved.x-.3)<.001);assert.ok(Math.abs(saved.y-.6)<.001);
 assert.equal(anchorFor([displays[0]],saved,240).display.id,1);
});
test('expanded panels stay in the display work area and transparent regions pass through',()=>{
 for(const display of displays)for(const x of [0,.5,1])for(const y of [0,.5,1])for(const panel of [{},{editor:true},{response:true},{editor:true,response:true}]){
 const anchor=anchorFor([display],{displayId:display.id,x,y},128),layout=layoutFor(display,anchor,128,panel),a=display.workArea,b=layout.bounds;
 assert.ok(b.x>=a.x&&b.y>=a.y);assert.ok(b.x+b.width<=a.x+a.width);assert.ok(b.y+b.height<=a.y+a.height);
 assert.ok(hitLayout(layout,{x:b.x+layout.art.x+10,y:b.y+layout.art.y+10}));
 if(panel.editor||panel.response){assert.ok(layout.panel);assert.ok(layout.panel.y+layout.panel.height<=b.height)}
 assert.equal(hitLayout(layout,{x:b.x-10,y:b.y-10}),false);
 }
});
function harness(){
 const handlers=new Map(),writes=[],messages=[];let cursor={x:1200,y:650};
 class Window extends EventEmitter{
  constructor(){super();this.visible=false;this.dead=false;this.webContents=new EventEmitter();this.webContents.mainFrame={url:''};this.webContents.send=(channel,data)=>messages.push({owner:this,channel,data});this.webContents.setWindowOpenHandler=()=>{};this.webContents.setZoomFactor=()=>{}}
  isDestroyed(){return this.dead}setAlwaysOnTop(){}setVisibleOnAllWorkspaces(){}setBounds(b){this.bounds=b}isVisible(){return this.visible}showInactive(){this.visible=true}hide(){this.visible=false}setIgnoreMouseEvents(value){this.ignored=value}focus(){}show(){this.visible=true}isMinimized(){return false}destroy(){this.dead=true}loadFile(file,options){this.webContents.mainFrame.url=pathToFileURL(file).href+(options?.query?'?desktopMascot=1':'')}loadURL(url){this.webContents.mainFrame.url=url}
 }
 const main=new Window();main.loadFile(path.join(process.cwd(),'dist/index.html'));
 const service=createDesktopMascot({mainWindow:main,isDev:false,root:process.cwd(),getSettings:()=>({mascot:DEFAULT_MASCOT_SETTINGS}),saveSettings:value=>writes.push(value),electron:{BrowserWindow:Window,ipcMain:{handle:(c,fn)=>handlers.set(c,fn),removeHandler:c=>handlers.delete(c)},screen:Object.assign(new EventEmitter(),{getAllDisplays:()=>displays,getPrimaryDisplay:()=>displays[0],getCursorScreenPoint:()=>cursor,getDisplayNearestPoint:()=>displays[0]}),Menu:{buildFromTemplate:()=>({popup(){}})}}});
 const call=(channel,value,owner=channel.startsWith('mascot:main-')?main:service.window)=>handlers.get(channel)({sender:owner.webContents,senderFrame:owner.webContents.mainFrame},value);
 return {service,handlers,messages,writes,main,call,setCursor:p=>cursor=p};
}
test('desktop prompt is scoped to selected main chat; acknowledgement and busy checks',()=>{
 const h=harness();try{
 assert.throws(()=>h.call('mascot:submit','Hi'),/Open a chat/);
 h.call('mascot:main-target',{id:'selected-tab',ready:true,name:'Test model'});
 assert.deepEqual(h.call('mascot:submit','  Hello  '),{accepted:true});
 const prompt=h.messages.find(m=>m.channel==='mascot:prompt').data;assert.equal(prompt.targetId,'selected-tab');assert.equal(prompt.text,'Hello');
 assert.throws(()=>h.call('mascot:submit','Duplicate'),/already working/);
 h.call('mascot:main-ack',{id:'wrong'});assert.equal(h.service.state().submitting,true);
 h.call('mascot:main-ack',{id:prompt.id});assert.equal(h.service.state().submitting,false);
 h.call('mascot:main-publish',{activity:{state:'working',id:'run-1',busy:true,reply:'Small reply'}});assert.equal(h.service.state().activity.reply,'Small reply');
 assert.throws(()=>h.call('mascot:submit','Busy'),/already working/);
 }finally{h.service.dispose();assert.equal(h.handlers.size,0)}
});
test('mascot IPC rejects other windows, subframes, navigated documents and invalid prompts',()=>{
 const h=harness();try{
 assert.throws(()=>h.call('mascot:main-publish',{},h.service.window),/Unauthorized/);
 const callback=h.handlers.get('mascot:get-state');
 assert.throws(()=>callback({sender:h.service.window.webContents,senderFrame:{url:h.service.window.webContents.mainFrame.url}}),/Unauthorized/);
 const url=h.service.window.webContents.mainFrame.url;h.service.window.webContents.mainFrame.url='https://example.com/';assert.throws(()=>h.call('mascot:get-state'),/Unauthorized/);h.service.window.webContents.mainFrame.url=url;
 for(const value of ['',{},'a'.repeat(32001)])assert.throws(()=>h.call('mascot:submit',value),/Enter a prompt/);
 }finally{h.service.dispose()}
});
test('native drag persists desktop display coordinates; lock blocks movement',()=>{
 const h=harness();try{
 h.call('mascot:drag-start');h.setCursor({x:600,y:300});h.call('mascot:drag-move');h.call('mascot:drag-end');
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].mascot.desktopPosition.displayId,1);assert.ok(h.writes[0].mascot.desktopPosition.x<.9);
 h.call('mascot:main-publish',{settings:{...h.writes[0].mascot,locked:true}});assert.equal(h.call('mascot:drag-start'),false);
 }finally{h.service.dispose()}
});

test('small work areas keep panels and artwork separate and within bounds',()=>{
    const display={id:3,workArea:{x:0,y:0,width:320,height:280}};
    for(const y of [0,.5,1]){
        const anchor=anchorFor([display],{displayId:3,x:.5,y},240);
        const l=layoutFor(display,anchor,240,{editor:true,response:true});
        assert.ok(l.bounds.height<=280);
        assert.ok(l.art.y+l.art.height<=280);
        assert.ok(l.panel.y+l.panel.height<=l.bounds.height);
        assert.ok(l.panel.y>=l.art.y+l.art.height || l.panel.y+l.panel.height<=l.art.y);
    }
});

test('selected-chat changes reject stale submissions and focused dialogs hide the companion',()=>{
    const h=harness();try{
        h.call('mascot:main-target',{id:'old-chat',ready:true});
        h.call('mascot:submit','Prompt');
        h.call('mascot:main-target',{id:'new-chat',ready:true});
        assert.equal(h.service.state().submitting,false);
        assert.match(h.service.state().activity.reply,/selected chat changed/);
        h.main.isFocused=()=>true;
        h.call('mascot:main-publish',{dialogOpen:true});h.service.reconcile();
        assert.equal(h.service.window.isVisible(),false);
        h.main.isFocused=()=>false;h.service.reconcile();assert.equal(h.service.window.isVisible(),true);
    }finally{h.service.dispose()}
});
