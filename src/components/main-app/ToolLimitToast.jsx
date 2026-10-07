import React, { useEffect, useRef, useState } from 'react';

export default function ToolLimitToast({ limit, onError }) {
  const [submitting, setSubmitting] = useState(false);
  const confirmButton = useRef(null);
  useEffect(() => { confirmButton.current?.focus(); }, []);
  const respond = async action => {
    setSubmitting(true);
    try {
      await window.chatAPI.respondToToolLimit(limit.requestId, action);
    } catch (error) {
      setSubmitting(false);
      onError(error.message);
    }
  };

  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="tool-limit-title"
      className="absolute top-3 left-1/2 z-50 w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-amber-400/40 bg-slate-900 p-4 text-white shadow-lg">
      <p id="tool-limit-title" className="text-sm">
        The assistant has executed {limit.currentCount} tool calls in casual mode and wants to continue with {limit.nextTool}.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button ref={confirmButton} type="button" disabled={submitting} onClick={() => respond('allow')}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm disabled:opacity-50">
          Confirm (+5 Calls)
        </button>
        <button type="button" disabled={submitting} onClick={() => respond('deny')}
          className="rounded border px-3 py-1.5 text-sm disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  );
}
