import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
    getMascotSettings, subscribeMascotSettings, initializeMascotSettings,
    updateMascotSettings, DEFAULT_MASCOT_SETTINGS,
} from '../../lib/mascotStore.mjs';
import { getMascotActivity, subscribeMascotActivity, shouldSleep } from '../../lib/mascotActivity.mjs';
import { point, normalized, facing } from '../../lib/mascotGeometry.mjs';
import { useModalActions, useModalState } from '../../context/UIStateContext.jsx';
import MascotArtwork from './MascotArtwork';
import { label } from './catalog';

const reducedQuery = '(prefers-reduced-motion: reduce)';
const readMotionPreference = () => window.matchMedia(reducedQuery).matches;
const subscribeMotionPreference = notify => {
    const media = window.matchMedia(reducedQuery);
    media.addEventListener('change', notify);
    return () => media.removeEventListener('change', notify);
};
export function useReducedAnimation(mode) {
    const system = useSyncExternalStore(subscribeMotionPreference, readMotionPreference);
    return mode === 'reduced' || (mode === 'system' && system);
}

export default function FloatingMascot() {
    const { settings, ready } = useSyncExternalStore(subscribeMascotSettings, getMascotSettings);
    const activity = useSyncExternalStore(subscribeMascotActivity, getMascotActivity);
    const [viewport, setViewport] = useState(() => ({ width: innerWidth, height: innerHeight }));
    const [visible, setVisible] = useState(!document.hidden);
    const [asleep, setAsleep] = useState(false);
    const [menu, setMenu] = useState(false);
    const [direction, setDirection] = useState('left');
    const node = useRef(null);
    const drag = useRef(null);
    const location = useRef(null);
    const lastActivity = useRef(Date.now());
    const actions = useModalActions();
    const modals = useModalState();
    const reduced = useReducedAnimation(settings.animation);
    const size = Math.max(1, Math.min(settings.size, viewport.width - 16, viewport.height - 44));
    const hidden = !!(modals?.settingsOpen || modals?.modelSelectorOpen || modals?.projectModalOpen);

    useEffect(() => { initializeMascotSettings(); }, []);
    useEffect(() => {
        const resize = () => setViewport({ width: innerWidth, height: innerHeight });
        const visibility = () => setVisible(!document.hidden);
        window.addEventListener('resize', resize);
        document.addEventListener('visibilitychange', visibility);
        return () => {
            window.removeEventListener('resize', resize);
            document.removeEventListener('visibilitychange', visibility);
        };
    }, []);
    useEffect(() => {
        lastActivity.current = Date.now();
        setAsleep(false);
    }, [activity]);
    useEffect(() => {
        if (!settings.enabled || !visible || hidden) return;
        const wake = () => { lastActivity.current = Date.now(); setAsleep(false); };
        window.addEventListener('pointerdown', wake);
        window.addEventListener('keydown', wake);
        const timer = setInterval(() => {
            setAsleep(shouldSleep(activity, Date.now() - lastActivity.current, settings.sleep));
        }, 1000);
        return () => {
            clearInterval(timer);
            window.removeEventListener('pointerdown', wake);
            window.removeEventListener('keydown', wake);
        };
    }, [activity, settings.sleep, settings.enabled, visible, hidden]);

    // Pointer moves update only this DOM node. Chat never subscribes to position.
    function place(position) {
        location.current = position;
        if (node.current) node.current.style.transform = `translate3d(${position.x}px,${position.y}px,0)`;
        setDirection(previous => settings.automaticFacing
            ? facing(position.x + size / 2, viewport.width, previous) : settings.facing);
    }
    useEffect(() => { place(point(settings.position, viewport, size)); },
        [settings.position, size, settings.automaticFacing, settings.facing, viewport]);

    function startDrag(event) {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
            id: event.pointerId, x: event.clientX, y: event.clientY,
            origin: location.current || point(settings.position, viewport, size), moved: false,
        };
    }
    function moveDrag(event) {
        const current = drag.current;
        if (!current || settings.locked || current.id !== event.pointerId) return;
        const dx = event.clientX - current.x, dy = event.clientY - current.y;
        if (!current.moved && Math.hypot(dx, dy) < 5) return;
        current.moved = true;
        place(point(normalized({ x: current.origin.x + dx, y: current.origin.y + dy }, viewport, size), viewport, size));
    }
    function finishDrag(event, cancelled = false) {
        const current = drag.current;
        if (!current || event.pointerId !== current.id) return;
        drag.current = null;
        if (cancelled) place(point(settings.position, viewport, size));
        else if (current.moved) updateMascotSettings({ position: normalized(location.current, viewport, size) });

        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }
    function reposition(event) {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setMenu(true); return; }
        if (settings.locked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const position = location.current || point(settings.position, viewport, size);
        const step = event.shiftKey ? 32 : 8;
        updateMascotSettings({ position: normalized({
            x: position.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
            y: position.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
        }, viewport, size) });
    }

    if (!ready || !settings.enabled || !visible || hidden) return null;
    const state = asleep && !activity.busy && activity.state === 'idle' ? 'sleepy' : activity.state;
    const position = point(settings.position, viewport, size);
    return (
        <div ref={node} className="continuum-mascot"
            onKeyDown={event => { if (event.key === 'Escape') setMenu(false); }}
            style={{ position: 'fixed', left: 0, top: 0, width: size, height: size + 28, zIndex: 30,
                transform: `translate3d(${position.x}px,${position.y}px,0)`, userSelect: 'none' }}>
            <button type="button"
                aria-label={`Continuum mascot: ${label(state)}. ${settings.locked ? 'Position locked.' : 'Drag or use arrow keys to move.'}`}
                aria-expanded={menu} onPointerDown={startDrag} onPointerMove={moveDrag}
                onPointerUp={finishDrag} onPointerCancel={event => finishDrag(event, true)} onKeyDown={reposition}
                onContextMenu={event => { event.preventDefault(); setMenu(true); }}
                style={{ display: 'block', width: '100%', height: size, padding: 0, border: 0,
                    background: 'transparent', touchAction: 'none', cursor: settings.locked ? 'pointer' : 'grab' }}>
                <MascotArtwork state={state} id={activity.id} size={size} hue={settings.hue} direction={direction} reduced={reduced} />
            </button>
            {menu && (
                <div role="group" aria-label="Mascot actions" style={{ position: 'absolute', bottom: 28,
                    left: (location.current?.x ?? position.x) < 168 - size ? 0 : undefined,
                    right: (location.current?.x ?? position.x) < 168 - size ? undefined : 0,
                    width: Math.min(168, viewport.width - 16), padding: 8, borderRadius: 8,
                    background: 'var(--surface-raised)', color: 'var(--text-primary)',
                    boxShadow: '0 4px 20px #0006', display: 'grid', gap: 8 }}>
                    <button onClick={() => { setMenu(false); actions?.openSettings('mascot'); }}>Mascot settings</button>
                    <button onClick={() => { updateMascotSettings({ position: DEFAULT_MASCOT_SETTINGS.position }); setMenu(false); }}>Reset position</button>
                    <button onClick={() => updateMascotSettings({ enabled: false })}>Hide mascot</button>
                </div>
            )}
        </div>
    );
}
