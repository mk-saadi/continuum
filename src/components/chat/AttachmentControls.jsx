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

export function AttachmentStorageStatus() {
  const [storage,setStorage]=useState(null),[problem,setProblem]=useState('');
  const refresh=async()=>{try {setStorage(await window.api.previewAttachmentCleanup());setProblem('');}catch{setProblem('Storage status is unavailable.');}};
  return <details className="text-[11px] text-[var(--text-muted)]" onToggle={event=>{if(event.currentTarget.open)refresh();}}>
    <summary>Attachment storage</summary>
    {storage && <p role="status">{storage.reclaimedBytes} bytes reclaimed; {storage.pendingFiles} pending files; {storage.retryableFailures} retryable failures; {storage.unresolvedLegacyItems} unresolved legacy items.</p>}
    <button type="button" onClick={refresh}>Preview cleanup counts</button>
    {problem && <p role="status">{problem}</p>}
  </details>;
}
