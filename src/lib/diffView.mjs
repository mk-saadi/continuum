// Pure unified-diff → side-by-side row transform for diff review. No DOM,
// no IPC — unit-testable under plain node. Git still computes the diff;
// this only aligns already-computed hunks into paired left/right rows.
// Anything unparseable (or too large) reports ok:false and the caller falls
// back to the raw unified text.

export const SIDE_BY_SIDE_ROW_CAP = 2000;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(text) {
  if (typeof text !== 'string' || !text) return { ok: false, rows: [], hunks: 0, capped: false };
  const lines = text.split('\n');
  // A single trailing element from the final newline is not a diff line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length > SIDE_BY_SIDE_ROW_CAP) return { ok: false, rows: [], hunks: 0, capped: true };
  const rows = [];
  let hunks = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  // Deletion rows awaiting a paired addition; additions fill them in order.
  let pending = [];
  for (const rawLine of lines) {
    const header = rawLine.startsWith('@@') ? HUNK_HEADER.exec(rawLine) : null;
    if (header) {
      inHunk = true;
      hunks += 1;
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      pending = [];
      rows.push({ type: 'hunk', text: rawLine });
      continue;
    }
    if (!inHunk) continue; // diff/index/---/+++ headers precede the first hunk
    const marker = rawLine[0];
    const content = rawLine.slice(1);
    if (marker === ' ') {
      pending = [];
      rows.push({ type: 'context', leftNo: oldNo, left: content, rightNo: newNo, right: content });
      oldNo += 1;
      newNo += 1;
    } else if (marker === '-') {
      const row = { type: 'del', leftNo: oldNo, left: content, rightNo: null, right: null };
      oldNo += 1;
      pending.push(row);
      rows.push(row);
    } else if (marker === '+') {
      const pair = pending.shift();
      if (pair) {
        pair.type = 'change';
        pair.rightNo = newNo;
        pair.right = content;
      } else {
        rows.push({ type: 'add', leftNo: null, left: null, rightNo: newNo, right: content });
      }
      newNo += 1;
    } else if (marker === '\\') {
      // "\ No newline at end of file" — annotation, not a counted line.
      rows.push({ type: 'note', text: rawLine });
    } else {
      return { ok: false, rows: [], hunks: 0, capped: false };
    }
  }
  if (!inHunk) return { ok: false, rows: [], hunks: 0, capped: false };
  return { ok: true, rows, hunks, capped: false };
}
