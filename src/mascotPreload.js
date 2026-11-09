'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('mascotAPI',{
    getState:()=>ipcRenderer.invoke('mascot:get-state'),
    onState:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('mascot:state',listener);return()=>ipcRenderer.removeListener('mascot:state',listener)},
    submit:text=>ipcRenderer.invoke('mascot:submit',text),
    setPanel:value=>ipcRenderer.invoke('mascot:set-panel',value),
    startDrag:()=>ipcRenderer.invoke('mascot:drag-start'),
    moveDrag:()=>ipcRenderer.invoke('mascot:drag-move'),
    endDrag:()=>ipcRenderer.invoke('mascot:drag-end'),
    move:direction=>ipcRenderer.invoke('mascot:keyboard-move',direction),
    contextMenu:()=>ipcRenderer.invoke('mascot:context-menu'),
    openMain:()=>ipcRenderer.invoke('mascot:open-main'),
    cancel:()=>ipcRenderer.invoke('mascot:cancel'),
});
