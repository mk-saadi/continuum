import { setAppearance } from "../../src/lib/appearance.mjs";
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TabProvider, useTabs } from '../../src/context/TabContext.jsx';
import { UIStateProvider, useLeftSidebar, useRightSidebar, useModalActions, useModalState } from '../../src/context/UIStateContext.jsx';
import CommandSpotlight from '../../src/components/CommandSpotlight.jsx';
window.calls = [];
window.setSpotlightAppearance = setAppearance;
window.api = { getModelLoadConfig: async () => ({config:{contextLength:8192,gpuOffload:'auto',threads:4,evalBatch:2048,physicalBatch:512,parallel:1,flashAttention:'auto'},remembered:false}), launchEngine: async id => {window.calls.push(['load',id]);return {success:true,modelPath:id};}, getMcpConfig: async () => ({ mcpServers: { files: { disabled: true }, browser: { disabled: false } } }), unloadEngine: async id => window.calls.push(['unload',id]) };
window.mcpAPI = { setServerEnabled: async (name, enabled) => { window.calls.push(['mcp', name, enabled]); if (window.failMcp) throw new Error('Connection failed'); } };
window.memoryPalace = {
  getAllSessions: async () => [{ folder_name: 'Chats', sessions: [{ id: 'saved', title: 'Saved conversation', model_id: 'test', project_id: null }] }],
  loadSession: async id => ({ id, title: 'Saved conversation', model_id: 'test', project_id: null }),
  searchMessages: async ({query,cursor}) => {
    window.calls.push(['search', query, cursor]);
    if(query === 'slow') await new Promise(resolve=>setTimeout(resolve,500));
    return {matches:[{id:42,session_id:'saved',session_title:query,excerpt:'[MATCH]found[/MATCH] message'}],cursor:cursor ? null : 42};
  },
};
function Probe() {
  const tabs = useTabs(), left = useLeftSidebar(), right = useRightSidebar(), modals = useModalState(), actions = useModalActions();
  window.state = { left:left.open, right:right.open, ...modals, tab:tabs.activeTab, count:tabs.tabs.length };
  return <><button id="origin">Original focus</button><button id="dismiss" onClick={()=>{actions.closeSettings();actions.closeModelSelector();}}>Dismiss modal flags</button></>;
}
createRoot(document.getElementById('root')).render(<UIStateProvider><TabProvider><Probe /><CommandSpotlight projects={[{id:'alpha',name:'Alpha',root_path:'/workspace/alpha'},{id:'beta',name:'Beta',root_path:'/workspace/beta'}]} models={[{id:'local-model',name:'Local model'}]} engines={[{modelPath:'running',modelName:'Running model',isLoaded:true}]} /></TabProvider></UIStateProvider>);
