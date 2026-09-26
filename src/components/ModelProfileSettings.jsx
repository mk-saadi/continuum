import React, { useEffect, useState } from 'react';
import { SliderField, NumberField, TextAreaField } from './FormControls';

const controls = [
  ['temperature', 'Temperature', 0, 2, 0.05], ['topP', 'Top-P', 0, 1, 0.05],
  ['topK', 'Top-K', 1, 100, 1], ['repeatPenalty', 'Repeat penalty', 1, 1.5, 0.01],
  ['maxTokens', 'Max tokens', -1, undefined, 1],
];
export default function ModelProfileSettings({ modelPath }) {
  const [open, setOpen] = useState(false);
  const [effective, setEffective] = useState(null);
  const [patch, setPatch] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    window.api?.getEffectiveSettings?.(null, modelPath).then(result => {
      if (active) { setEffective(result.effective); setPatch({}); }
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [open, modelPath]);
  async function save(reset = false) {
    setSaving(true); setError('');
    try {
      await window.api.saveProfileSettings(modelPath, reset ? null : patch);
      const result = await window.api.getEffectiveSettings(null, modelPath);
      setEffective(result.effective); setPatch({});
      window.dispatchEvent(new Event('generation-settings-changed'));
    } catch (error) { setError(error.message); }
    finally { setSaving(false); }
  }
  return <details className="w-full rounded border border-[var(--border)] p-2" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-xs font-medium">{modelPath ? 'Model default prompt & sampling' : 'Global default prompt & sampling'}</summary>
    {open && effective && <div className="mt-3 space-y-3">
      <TextAreaField label={modelPath ? 'Model Default System Prompt' : 'Global Default System Prompt'}
        value={patch.systemPrompt ?? effective.systemPrompt} maxLength={32000} rows={4} disabled={saving}
        onChange={event => setPatch(value => ({ ...value, systemPrompt: event.target.value }))} />
      {controls.map(([key, label, min, max, step]) => {
        const Control = key === 'maxTokens' ? NumberField : SliderField;
        return <Control key={key} label={label} min={min} max={max} step={step} disabled={saving}
          value={patch[key] ?? effective[key]} {...(key === 'maxTokens' ? {} : { valueLabel: patch[key] ?? effective[key] })}
          onChange={event => setPatch(value => ({ ...value, [key]: event.target.value === '' ? '' : Number(event.target.value) }))} />;
      })}
      <p className="text-xs text-[var(--text-muted)]">Only edited fields are saved. Unset model fields inherit global defaults. Max tokens: -1 means unlimited.</p>
      <div className="flex gap-2">
        <button type="button" disabled={saving || !Object.keys(patch).length} onClick={() => save()} className="rounded border px-2 py-1 text-xs disabled:opacity-40">Save defaults</button>
        {modelPath && <button type="button" disabled={saving} onClick={() => save(true)} className="rounded border px-2 py-1 text-xs">Inherit global defaults</button>}
      </div>
    </div>}
    {error && <p role="alert" className="text-xs text-[var(--error)]">{error}</p>}
  </details>;
}
