import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInterface } from '../../src/components/main-app/ChatInterface.jsx';

window.fixtureSubmitted=null;
window.addEventListener('error',event=>{window.fixtureError=String(event.error?.stack || event.message);});
function Fixture() {
  const [sessionId,setSessionId]=useState('ui-selection');
  window.changeFixtureSession=setSessionId;
  const palace={api:window.memoryPalace,sessionId,setSessionId,enabled:false,setDraftTokens(){},refresh:async()=>{},schedule(){},
    prepareMessages:async(text,retry,attachments)=>{
      window.fixtureSubmitted={sessionId,attachments};
      window.fixtureMessages=await window.memoryPalace.prepareChatMessages(sessionId,'/fixture-model.gguf',text,false,retry,attachments);
      throw new Error('Fixture stopped after immutable request preparation.');
    }};
  return <ChatInterface key={sessionId} palace={palace} selectedModel="/fixture-model.gguf" models={[{id:'/fixture-model.gguf',name:'Fixture'}]}
    baseUrl="http://fixture.invalid" engineRunning tabActive isSidebarOpen={false} isRightSidebarOpen={false} />;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
