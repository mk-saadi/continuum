import React, { useEffect, useState } from 'react';
import { LuChevronDown, LuSlidersHorizontal } from 'react-icons/lu';
import { SliderField, NumberField, TextAreaField } from './FormControls';
import {
  SettingsButton,
  SettingsCheckRow,
  SettingsHint,
  SettingsMessage,
  settingsCard,
} from './settings/SettingsSection';

const controls = [
  ['temperature', 'Temperature', 0, 2, 0.05], ['topP', 'Top-P', 0, 1, 0.05],
  ['topK', 'Top-K', 1, 100, 1], ['repeatPenalty', 'Repeat penalty', 1, 1.5, 0.01],
  ['maxTokens', 'Max tokens', -1, undefined, 1],
];
export default function ModelProfileSettings({ modelPath, section = 'all', heading }) {
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
  const label = section === 'memory'
    ? (modelPath ? 'Model memory overrides' : 'Global memory defaults')
    : (modelPath ? 'Model default prompt & sampling' : 'Global default prompt & sampling');
  return <details className={`${settingsCard} group`} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-semibold text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
      <span className="flex min-w-0 items-center gap-2">
        <LuSlidersHorizontal size={16} aria-hidden="true" className="shrink-0 text-[var(--accent)]" />
        <span className="truncate">{heading ? `${heading} — ${label}` : label}</span>
      </span>
      <LuChevronDown size={14} aria-hidden="true" className="shrink-0 text-[var(--text-muted)] transition-transform duration-200 group-open:rotate-180" />
    </summary>
    {open && effective && <div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
      {section !== 'memory' && <TextAreaField label={modelPath ? 'Model Default System Prompt' : 'Global Default System Prompt'}
        value={patch.systemPrompt ?? effective.systemPrompt} maxLength={32000} rows={4} disabled={saving}
        onChange={event => setPatch(value => ({ ...value, systemPrompt: event.target.value }))} />}
      {section !== 'generation' && [['memoryEnabled', 'Enable Memory (Facts & Past Chats)'], ['compactionEnabled', 'Auto-Compress Long Chats']].map(([key, itemLabel]) =>
        <SettingsCheckRow key={key} role="switch" label={itemLabel} disabled={saving}
          checked={patch[key] ?? effective[key] ?? true} onChange={event => setPatch(value => ({ ...value, [key]: event.target.checked }))} />)}
      {section !== 'memory' && controls.map(([key, itemLabel, min, max, step]) => {
        const Control = key === 'maxTokens' ? NumberField : SliderField;
        return <Control key={key} label={itemLabel} min={min} max={max} step={step} disabled={saving}
          value={patch[key] ?? effective[key]} {...(key === 'maxTokens' ? {} : { valueLabel: patch[key] ?? effective[key] })}
          onChange={event => setPatch(value => ({ ...value, [key]: event.target.value === '' ? '' : Number(event.target.value) }))} />;
      })}
      <SettingsHint>Only edited fields are saved. Unset model fields inherit global defaults. {section !== 'memory' && 'Max tokens: -1 means unlimited.'}</SettingsHint>
      <div className="flex flex-wrap items-center gap-2">
        <SettingsButton type="button" variant="primary" disabled={saving || !Object.keys(patch).length} onClick={() => save()}>Save defaults</SettingsButton>
        {modelPath && <SettingsButton type="button" disabled={saving} onClick={() => save(true)}>Inherit all global defaults</SettingsButton>}
      </div>
      <SettingsMessage>{error}</SettingsMessage>
    </div>}
    {!open && error && <SettingsMessage>{error}</SettingsMessage>}
  </details>;
}
