import {useMemoryPalace} from '../../src/components/MemoryPalace.jsx';
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useCompactionActivity} from '../../src/hooks/useCompactionActivity.js';
import {WorkspaceMessage} from '../../src/components/chat/WorkspaceTimeline.jsx';
window.memoryPalace={getContextUsage:async()=>({totalTokens:10000}),getCoreMemories:async()=>[],onCompressionComplete:callback=>{window.emitCompression=callback;return()=>{window.emitCompression=null;};}};
window.api={getEffectiveSettings:async()=>({effective:{memoryEnabled:true}})};
function Counter(){const palace=useMemoryPalace('model',{contextLength:40000},'a',null,{isActive:false});window.counterState=palace;return <output data-counter>{palace.contextTokens}</output>;}
const listeners=new Set();
window.activityListeners=listeners;
window.activityStore={a:[],b:[]};
const api={listCompactionActivity:async id=>window.activityStore[id]??[],onCompactionActivity:(id,callback)=>{
 const listener=e=>{if(e.session_id===id)callback(e);}; listeners.add(listener);return()=>listeners.delete(listener);
}};
window.emitActivity=e=>{window.activityStore[e.session_id]=[e];for(const listener of listeners)listener(e);};
function App(){
 const [sessionId,setSessionId]=useState('a');const [mounted,setMounted]=useState(true);
 window.selectActivitySession=setSessionId;window.mountActivity=setMounted;
 return <><Counter/>{mounted?<Chat sessionId={sessionId}/>:null}</>;
}
function Chat({sessionId}){
 const events=useCompactionActivity(api,sessionId,true);
 const message={id:sessionId==='a'?1:2,role:'assistant',run_id:`run-${sessionId}`,content:'Final response',executionSteps:[
 {id:'read',type:'tool_call',toolName:'read_project_file',args:{relative_path:'before.js'},status:'complete',result:'read'},
 {id:'after',type:'tool_call',toolName:'read_project_file',args:{relative_path:'after.js'},status:'complete',result:'read'}]};
 return <WorkspaceMessage message={message} compactionActivity={events} />;
}
createRoot(document.getElementById('root')).render(<App/>);
