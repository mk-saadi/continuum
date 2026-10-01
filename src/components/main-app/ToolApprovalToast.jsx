import React, { useState } from 'react';

export default function ToolApprovalToast({ approval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const respond = async action => {
    setBusy(true);
    try { await window.chatAPI.respondToToolApproval(approval.requestId, approval.approvalId, action); }
    catch (error) { setError(error.message); setBusy(false); }
  };
  return <div role="alertdialog" aria-labelledby="tool-approval-title"
    className="absolute top-3 left-1/2 z-[60] w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-amber-400/40 bg-[var(--surface)] p-4 text-[var(--text-primary)] shadow-lg">
    <p id="tool-approval-title">Allow {approval.name}?</p>
    <pre className="my-2 max-h-52 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(approval.args, null, 2)}</pre>
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-2">
      <button type="button" disabled={busy} onClick={() => respond('allow')} className="rounded bg-blue-600 px-3 py-1.5 text-white">Allow once</button>
      <button type="button" disabled={busy} onClick={() => respond('deny')} className="rounded border px-3 py-1.5">Deny</button>
    </div>
  </div>;
}
