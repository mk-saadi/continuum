import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import FloatingMascot from '../../src/components/mascot/FloatingMascot';
import MascotSettings from '../../src/components/mascot/MascotSettings';
import { UIStateProvider, useModalActions } from '../../src/context/UIStateContext';
import { mascotEvent, selectMascotSession, mascotAttention } from '../../src/lib/mascotActivity.mjs';
import { updateMascotSettings, getMascotSettings } from '../../src/lib/mascotStore.mjs';
import '../../src/index.css';
window.api = { getAppSettings: async () => JSON.parse(localStorage.getItem('fixture-settings') || '{}'), saveAppSettings: async (patch) => { localStorage.setItem('fixture-settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('fixture-settings') || '{}'), ...patch })); } };
window.mascotTest = { event: mascotEvent, select: selectMascotSession, attention: mascotAttention, update: updateMascotSettings, get: getMascotSettings };
function ModalProbe() { const actions = useModalActions(); window.mascotTest.modals = actions; return <dialog id="approval"><p>Tool approval required</p><button id="approve" onClick={() => document.querySelector('#approval').close()}>Approve</button></dialog>; }
function Fixture() { const [active, setActive] = useState(true); return <UIStateProvider><ModalProbe /><main style={{ maxWidth: 520, padding: 24 }}><h1>Continuum mascot</h1><button id="toggle-preview" onClick={() => setActive(v => !v)}>Toggle preview context</button><MascotSettings active={active}/><button id="underlay">Application control</button></main><FloatingMascot /></UIStateProvider>; }
createRoot(document.getElementById('root')).render(<Fixture />);
