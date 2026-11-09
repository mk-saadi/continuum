import React, { useEffect, useRef } from 'react';
import { createPlayback } from '../../lib/mascotPlayback.mjs';
import { mayMirror } from '../../lib/mascotGeometry.mjs';
import { clipFor, prepareClip } from './catalog';
export default function MascotArtwork({ state, id, size, reduced, hue = 0, direction = 'left' }) {
    const host = useRef(null), current = useRef(null), controller = useRef(null), visual = useRef({ hue, direction });
    visual.current = { hue, direction };
    const density = window.devicePixelRatio || 1;
    function style(ready, clipState) { ready.img.dataset.state = clipState; ready.img.style.cssText = `width:100%;height:100%;object-fit:contain;filter:hue-rotate(${visual.current.hue}deg);transform:scaleX(${visual.current.direction === 'right' && mayMirror(clipState) ? -1 : 1});pointer-events:none`; }
    useEffect(() => {
        const catalog = (s, p) => clipFor(s, p, size, density);
        controller.current = createPlayback({ catalog, prepare: c => prepareClip(c, reduced).catch(() => prepareClip(c, true)), display: (ready, clip) => {
                current.current?.dispose();
                current.current = ready;
                ready.img.dataset.part = clip.part;
                style(ready, clip.state);
                host.current?.replaceChildren(ready.img);
                const next = catalog(clip.state, clip.part === 'entry' ? 'main' : 'hold');
                if (next && !reduced)
                    prepareClip(next, false).then(p => p.dispose()).catch(() => { });
            } });
        return () => { controller.current?.stop(); current.current?.dispose(); current.current = null; };
    }, [size, reduced, density]);
    useEffect(() => { controller.current?.set(state, id, reduced); }, [state, id, size, reduced, density]);
    useEffect(() => { if (current.current)
        style(current.current, current.current.img.dataset.state); }, [hue, direction]);
    return <span ref={host} aria-hidden="true" style={{ display: 'block', width: '100%', height: '100%' }}><span style={{ fontSize: 40 }}>◉</span></span>;
}
