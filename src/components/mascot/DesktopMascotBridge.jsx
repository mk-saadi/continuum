import {useEffect,useSyncExternalStore} from 'react';
import {useModalActions,useModalState} from '../../context/UIStateContext';
import {initializeMascotSettings,getMascotSettings,subscribeMascotSettings} from '../../lib/mascotStore.mjs';
import {getMascotActivity,subscribeMascotActivity} from '../../lib/mascotActivity.mjs';
export default function DesktopMascotBridge(){
    const {settings,ready}=useSyncExternalStore(subscribeMascotSettings,getMascotSettings);
    const activity=useSyncExternalStore(subscribeMascotActivity,getMascotActivity);
    const actions=useModalActions();
    const modals=useModalState();
    const dialogOpen=!!(modals?.settingsOpen||modals?.modelSelectorOpen||modals?.projectModalOpen);
    useEffect(()=>{initializeMascotSettings()},[]);
    useEffect(()=>{if(ready)window.desktopMascotMain?.publish({settings,activity,dialogOpen}).catch(()=>{})},[settings,activity,ready,dialogOpen]);
    useEffect(()=>window.desktopMascotMain?.onOpenSettings(()=>actions?.openSettings('mascot')),[actions]);
    return null;
}
