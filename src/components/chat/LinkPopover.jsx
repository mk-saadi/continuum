import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiCheck, FiCopy, FiExternalLink } from "react-icons/fi";
import { clampMenuPosition } from "../../lib/textSelection.mjs";

const itemClass = "flex cursor-pointer items-center gap-1.5 ui-radius-control px-2.5 py-1.5 text-xs whitespace-nowrap text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]";

export default function LinkPopover({ href, children, ...props }) {
 const [position, setPosition] = useState(null);
 const [copied, setCopied] = useState(false);
 const [error, setError] = useState("");
 const anchor = useRef(null);
 const panel = useRef(null);
 const copyButton = useRef(null);
 useEffect(() => {
  setPosition(null); setCopied(false); setError("");
 }, [href]);
 useEffect(() => {
  if (!position) return;
  copyButton.current?.focus();
  const close = () => setPosition(null);
  const outside = event => {
   if (!panel.current?.contains(event.target) && !anchor.current?.contains(event.target)) close();
  };
  const key = event => {
   if (event.key === "Escape") { event.preventDefault(); close(); anchor.current?.focus(); }
  };
  document.addEventListener("pointerdown", outside);
  document.addEventListener("keydown", key);
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  return () => {
   document.removeEventListener("pointerdown", outside);
   document.removeEventListener("keydown", key);
   window.removeEventListener("scroll", close, true);
   window.removeEventListener("resize", close);
  };
 }, [position]);
 return <>
  <a {...props} ref={anchor} href={href} aria-haspopup="dialog" aria-expanded={!!position}
   className="text-[var(--link)] underline cursor-pointer"
   onClick={event => {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    setCopied(false); setError("");
    setPosition(clampMenuPosition(event.currentTarget.getBoundingClientRect(), 280, 44, 10));
   }}>
   {children}
  </a>
  {position && createPortal(<div ref={panel} role="dialog" aria-label="Link actions"
   className="fixed z-[80] flex flex-wrap items-center gap-1 ui-radius-surface border border-[var(--border)] bg-[var(--surface-raised)] p-1 shadow-[0_8px_30px_var(--window-shadow)]"
   style={{ left: position.left, top: position.top, maxWidth: "calc(100vw - 16px)" }}>
   <button ref={copyButton} type="button" className={itemClass} onClick={async () => {
    try { await navigator.clipboard.writeText(href); setCopied(true); setError(""); }
    catch { setError("Could not copy link."); }
   }}>{copied ? <FiCheck aria-hidden="true" /> : <FiCopy aria-hidden="true" />}{copied ? "Copied" : "Copy link"}</button>
   <button type="button" className={itemClass} onClick={() => {
    window.open(href, "_blank", "noopener,noreferrer"); setPosition(null); anchor.current?.focus();
   }}><FiExternalLink aria-hidden="true" />Open in browser</button>
   {error && <span role="status" className="px-2 text-xs text-[var(--error)]">{error}</span>}
  </div>, anchor.current?.closest("dialog[open]") ?? document.body)}
 </>;
}
