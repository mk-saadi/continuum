import React, { useRef, useState } from 'react';

export default function ResizableSidebar({ open, children }) {
  const root = useRef(null);
  const [width, setWidth] = useState(null);
  function limits() {
    const available = root.current?.parentElement?.clientWidth || window.innerWidth;
    return { min: Math.min(200, available / 2), max: Math.min(560, available / 2) };
  }
  function update(value) {
    const { min, max } = limits();
    setWidth(Math.round(Math.max(min, Math.min(max, value))));
  }
  return <div ref={root} id="chat-sidebar" aria-hidden={!open} inert={open ? undefined : ''}
    style={open && width !== null ? { width: `min(${width}px, 50%)` } : undefined}
    className={`relative z-20 h-full shrink-0 ${open ? 'w-[272px] max-[650px]:w-[220px]' : 'w-0'}`}>
    <div className={`absolute inset-y-0 left-0 w-full overflow-hidden transition-[translate,opacity] duration-300 ease-in-out motion-reduce:transition-none ${open ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0'}`}>
      {children}
    </div>
    {open && <div role="separator" aria-label="Resize left sidebar" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={limits().min} aria-valuemax={limits().max} aria-valuenow={width ?? root.current?.clientWidth ?? 272}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event.clientX - root.current.getBoundingClientRect().left); }}
      onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          update(root.current.clientWidth + (event.key === 'ArrowLeft' ? -16 : 16));
        }
      }}
      className="absolute inset-y-0 -right-1 z-30 w-2 cursor-col-resize touch-none border-x border-transparent hover:bg-[var(--accent)]/30 focus-visible:bg-[var(--accent)]/30 focus-visible:outline-none" />}
  </div>;
}
