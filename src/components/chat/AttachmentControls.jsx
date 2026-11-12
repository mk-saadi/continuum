import React, { useEffect, useState } from 'react';

export function AttachmentControls({ attachment, sessionId = attachment.session_id, onChange, disabled = false, expanded = false }) {
  const [open,setOpen]=useState(expanded), [current,setCurrent]=useState(attachment), [busy,setBusy]=useState(false), [problem,setProblem]=useState(''), [storage,setStorage]=useState(null);
  useEffect(()=>setCurrent(attachment),[attachment]);
  const refresh=async()=>{
    try { setCurrent(await window.api.inspectAttachment({sessionId,attachment:current})); }
    catch(error) { setProblem(error.message); }
  };
  useEffect(()=>{ if(open) refresh(); },[open,attachment.version_id]);
  const act=async(action)=>{
    setBusy(true); setProblem('');
    try {
      const result=await window.api.recoverAttachment({sessionId,attachment:current,action});
      if(result) setCurrent(result);
      if(result || action==='omit') onChange?.(result);
      window.dispatchEvent(new CustomEvent('attachments-changed',{detail:{sessionId}}));
    } catch(error) { setProblem(error.message); }
    finally { setBusy(false); }
  };
  return <div className="text-[11px] text-[var(--text-muted)]" onClick={event=>event.stopPropagation()}>
    <span>{current.omitted ? 'Omitted' : current.storage_kind==='referenced' ? 'Referenced file' : 'Managed copy'}</span>
    {current.storage_kind==='referenced' && <button type="button" disabled={disabled||busy} className="ml-2 underline" onClick={()=>act('copy')}>Keep a copy</button>}
    <button type="button" className="ml-2 underline" onClick={()=>setOpen(value=>!value)}>{open?'Hide details':'Details'}</button>
    {open && <div className="mt-1 max-w-md space-y-1 break-words" aria-label="Attachment details">
      <button type="button" onClick={async()=>{try {setStorage(await window.api.previewAttachmentCleanup());}catch(error){setProblem(error.message);}}}>Storage cleanup status</button>
      {storage && <p role="status">{storage.reclaimedBytes} bytes reclaimed; {storage.pendingFiles} pending files; {storage.retryableFailures} retryable failures; {storage.unresolvedLegacyItems} unresolved legacy items.</p>}
      <p>{current.name || 'Attachment'}</p>
      <p>{current.file_path}</p>
      <p>{current.fingerprint ? `SHA-256 ${current.fingerprint}` : 'Legacy copy; fingerprint is recorded on first verified read.'}</p>
      <p role="status">{current.problem || current.status || 'Checking source…'}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={disabled||busy} onClick={()=>act('locate')}>Locate file</button>
        <button type="button" disabled={disabled||busy} onClick={()=>act('replace')}>Choose new version</button>
        {current.storage_kind==='referenced' && <button type="button" disabled={disabled||busy} onClick={()=>act('accept')}>Accept changed version</button>}
        {current.has_copy && current.storage_kind==='referenced' && <button type="button" disabled={disabled||busy} onClick={()=>act('use-copy')}>Use saved copy</button>}
        <button type="button" disabled={disabled||busy} onClick={()=>act(current.omitted?'restore':'omit')}>{current.omitted?'Restore attachment':'Omit attachment'}</button>
      </div>
    </div>}
    {busy && <p role="status">Verifying attachment…</p>}
    {problem && <p role="alert" className="text-[var(--error)]">{problem}</p>}
  </div>;
}

export function AttachmentIssues({sessionId, refreshKey}) {
  const [issues,setIssues]=useState([]);
  useEffect(()=>{
    let live=true;
    const refresh=()=>window.api?.attachmentIssues?.(sessionId).then(rows=>{if(live)setIssues(rows);}).catch(()=>{});
    if(sessionId) refresh();
    window.addEventListener('attachments-changed',refresh);
    return ()=>{live=false;window.removeEventListener('attachments-changed',refresh);};
  },[sessionId,refreshKey]);
  if(!issues.length)return null;
  return <div aria-label="Attachments needing attention" className="border border-[var(--border)] p-2">
    <p>Attachments need attention before sending. Resolve each source or explicitly omit it.</p>
    {issues.map(file=><AttachmentControls key={file.id} attachment={file} sessionId={sessionId} expanded />)}
  </div>;
}

function formatStorageBytes(value) {
  if (!Number.isFinite(value) || value < 0) return 'Unknown';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export function AttachmentStorageStatus() {
  const [storage,setStorage]=useState(null),[problem,setProblem]=useState(''),[busy,setBusy]=useState(false);
  const refresh=async()=>{
    if (!window.api?.previewAttachmentCleanup) { setProblem('Storage status is unavailable.'); return; }
    setBusy(true);
    try { setStorage(await window.api.previewAttachmentCleanup()); setProblem(''); }
    catch { setProblem('Storage status is unavailable.'); }
    finally { setBusy(false); }
  };
  useEffect(()=>{
    refresh();
    const onChanged=()=>refresh();
    window.addEventListener('attachments-changed',onChanged);
    return ()=>window.removeEventListener('attachments-changed',onChanged);
  },[]);

  const pending=storage?.pendingFiles ?? 0;
  const failures=storage?.retryableFailures ?? 0;
  const unused=storage?.unusedVersions ?? 0;
  const unresolved=storage?.unresolvedLegacyItems ?? 0;
  const active=storage?.activeOperations ?? 0;
  const needsAttention=pending>0 || failures>0 || unused>0 || active>0;

  return <div className="aero-panel sk-panel p-3" aria-label="Attachment storage">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold">Attachment storage</h3>
      <button type="button" className="text-[11px] underline text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-60" onClick={refresh} disabled={busy}>{busy?'Checking…':'Refresh'}</button>
    </div>
    <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">Temporary copies and cleanup status for stored attachments.</p>
    {storage ? <div className="mt-2 space-y-1.5 text-[11px]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[var(--text-secondary)]">Reclaimed so far</span>
        <span className="font-medium tabular-nums">{formatStorageBytes(storage.reclaimedBytes)}</span>
      </div>
      {needsAttention ? <>
        {pending>0 && <div className="flex items-center justify-between gap-3">
          <span className="text-[var(--text-secondary)]">Pending cleanup</span>
          <span className="font-medium tabular-nums text-amber-500">{pending} file{pending===1?'':'s'}</span>
        </div>}
        {unused>0 && <div className="flex items-center justify-between gap-3">
          <span className="text-[var(--text-secondary)]">Unused versions</span>
          <span className="font-medium tabular-nums">{unused}</span>
        </div>}
        {failures>0 && <div className="flex items-center justify-between gap-3">
          <span className="text-[var(--text-secondary)]">Retryable failures</span>
          <span className="font-medium tabular-nums text-[var(--error)]">{failures}</span>
        </div>}
        {active>0 && <div className="flex items-center justify-between gap-3">
          <span className="text-[var(--text-secondary)]">Cleanup running</span>
          <span className="font-medium tabular-nums">{active}</span>
        </div>}
      </> : <p className="text-[var(--text-muted)]">Nothing needs cleanup.</p>}
      {unresolved>0 && <details className="pt-1 text-[var(--text-muted)]">
        <summary className="cursor-pointer select-none">Storage notes</summary>
        <p className="mt-1 leading-relaxed">{unresolved} unrecognized legacy item{unresolved===1?'':'s'} kept for safety; they are not removed automatically.</p>
      </details>}
    </div> : !problem && <p className="mt-2 text-[11px] text-[var(--text-muted)]">Checking storage…</p>}
    {problem && <p role="alert" className="mt-2 text-[11px] text-[var(--error)]">{problem}</p>}
  </div>;
}
