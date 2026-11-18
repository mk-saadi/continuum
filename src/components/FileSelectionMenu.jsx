import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clampMenuPosition } from '../lib/textSelection.mjs';

// Translate a DOM boundary to a source offset without counting the gutter.
function sourceOffset(root, container, offset) {
 const boundary = document.createRange();
 boundary.setStart(container, offset); boundary.collapse(true);
 const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
 let total = 0;
 while (walker.nextNode()) {
  const node = walker.currentNode;
  if (node.parentElement.closest('.react-syntax-highlighter-line-number')) continue;
  if (node === container) return total + offset;
  if (boundary.comparePoint(node, node.length) > 0) return total;
  total += node.length;
 }
 return total;
}

export default function FileSelectionMenu({ paint, editor, editing, text, path, dirty, onAddToChat }) {
 const pointerHeld = useRef(false);
 const [selection, setSelection] = useState(null);
 useEffect(() => {
  if (!onAddToChat) return;
  let frame = 0;
  const read = () => {
   frame = 0;
   if (pointerHeld.current) return;
   let start, end, rect;
   if (editing) {
    const input = editor.current;
    if (!input || document.activeElement !== input) { setSelection(null); return; }
    start = input.selectionStart; end = input.selectionEnd;
    // The native textarea does not expose a selection rectangle. Anchor its
    // action inside the visible editor instead of guessing a caret position.
    const bounds = input.getBoundingClientRect();
    rect = { left: bounds.left + 16, top: bounds.bottom - 12, bottom: bounds.bottom };
   } else {
    const selected = window.getSelection();
    const root = paint.current;
    if (!root || !selected?.rangeCount || selected.isCollapsed || !root.contains(selected.anchorNode) || !root.contains(selected.focusNode)) { setSelection(null); return; }
    const range = selected.getRangeAt(0);
    start = sourceOffset(root, range.startContainer, range.startOffset);
    end = sourceOffset(root, range.endContainer, range.endOffset);
    rect = range.getBoundingClientRect();
   }
   if (start === end || !text.slice(start, end).trim()) { setSelection(null); return; }
   setSelection({ start, end, ...clampMenuPosition(rect, 120, 34, 6) });
  };
  const schedule = () => { if (!pointerHeld.current && !frame) frame = requestAnimationFrame(read); };
  const dismiss = () => setSelection(null);
  const pointerDown = event => {
   if (event.target.closest?.('[aria-label="Add file selection to chat"]')) return;
   pointerHeld.current = true;
   cancelAnimationFrame(frame); frame = 0;
   dismiss();
  };
  const pointerUp = event => {
   pointerHeld.current = false;
   if (!event.target.closest?.('[aria-label="Add file selection to chat"]')) schedule();
  };
  const pointerCancel = () => { pointerHeld.current = false; dismiss(); };
  document.addEventListener('pointerdown', pointerDown, true);
  document.addEventListener('pointerup', pointerUp, true);
  document.addEventListener('pointercancel', pointerCancel, true);
  window.addEventListener('blur', pointerCancel);
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('select', schedule, true);
  window.addEventListener('scroll', dismiss, true);
  window.addEventListener('resize', dismiss);
  setSelection(null);
  return () => {
   cancelAnimationFrame(frame);
   document.removeEventListener('pointerdown', pointerDown, true);
   document.removeEventListener('pointerup', pointerUp, true);
   document.removeEventListener('pointercancel', pointerCancel, true);
   window.removeEventListener('blur', pointerCancel);
   document.removeEventListener('selectionchange', schedule);
   document.removeEventListener('select', schedule, true);
   window.removeEventListener('scroll', dismiss, true);
   window.removeEventListener('resize', dismiss);
  };
 }, [editing, text, path, paint, editor, onAddToChat]);
 if (!selection || !onAddToChat) return null;
 return createPortal(<button type="button" aria-label="Add file selection to chat"
  className="material-control sk-button material-fill sk-fill ui-radius-control fixed z-[80] cursor-pointer border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-xs text-[var(--text-primary)] shadow-lg"
  style={{ left: selection.left, top: selection.top }}
  onPointerDown={event => event.preventDefault()}
  onClick={() => {
   const { start, end } = selection;
   const first = text.slice(0, start).split('\n').length;
   const last = text.slice(0, end > start && text[end - 1] === '\n' ? end - 1 : end).split('\n').length;
   onAddToChat(`${path}:${first}${last !== first ? `-${last}` : ''}${dirty ? ' (unsaved edits)' : ''}\n\n${text.slice(start, end)}`);
   setSelection(null);
  }}>Add to chat</button>, document.body);
}
