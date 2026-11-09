import React, { useEffect, useState, useSyncExternalStore } from 'react';
import {
    getMascotSettings, subscribeMascotSettings, initializeMascotSettings,
    updateMascotSettings, DEFAULT_MASCOT_SETTINGS,
} from '../../lib/mascotStore.mjs';
import { SettingsCard, SettingsHint, SettingsCheckRow, SettingsButton } from '../settings/SettingsSection';
import { SelectField, SliderField } from '../FormControls';
import MascotArtwork from './MascotArtwork';
import { useReducedAnimation } from './FloatingMascot';
import { expressions, label } from './catalog';

export default function MascotSettings({ active }) {
    const { settings, error } = useSyncExternalStore(subscribeMascotSettings, getMascotSettings);
    const [preview, setPreview] = useState('');
    const [instance, setInstance] = useState(0);
    const reduced = useReducedAnimation(settings.animation);
    useEffect(() => { initializeMascotSettings(); }, []);
    useEffect(() => { if (!active) setPreview(''); }, [active]);
    const change = (key, value) => updateMascotSettings({ [key]: value });
    const checkbox = (key, title) => (
        <SettingsCheckRow className="py-2" label={title} checked={settings[key]}
            onChange={event => change(key, event.target.checked)} />
    );
    const select = (key, title, options) => (
        <SelectField className="py-2" label={title} value={settings[key]}
            onChange={event => change(key, key === 'sleep' ? Number(event.target.value) : event.target.value)}>
            {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </SelectField>
    );
    return (
        <SettingsCard title="Continuum mascot" className="space-y-2">
            {checkbox('enabled', 'Enable mascot')}
            <SliderField label="Size" valueLabel={`${settings.size} px`} aria-label="Mascot size"
                min={80} max={240} step={1} value={settings.size}
                onChange={event => change('size', Number(event.target.value))} />
            <SliderField label="Color hue" valueLabel={`${settings.hue}°`} aria-label="Mascot color hue"
                min={0} max={360} step={1} value={settings.hue}
                onChange={event => change('hue', Number(event.target.value))} />
            <SettingsButton onClick={() => change('hue', 0)}>Reset hue</SettingsButton>
            <SettingsHint>Hue changes baked face colors too, including red error symbols.</SettingsHint>
            {checkbox('automaticFacing', 'Automatic inward facing')}
            {!settings.automaticFacing && select('facing', 'Facing', [['left', 'Left'], ['right', 'Right']])}
            {select('animation', 'Animation mode', [['system', 'System'], ['full', 'Full'], ['reduced', 'Reduced']])}
            {select('sleep', 'Sleep after inactivity', [[0, 'Never'], [1, '1 minute'], [5, '5 minutes'], [15, '15 minutes']])}
            {checkbox('locked', 'Lock position')}
            <div className="flex flex-wrap gap-3 py-2">
                <SettingsButton onClick={() => updateMascotSettings({position:DEFAULT_MASCOT_SETTINGS.position,desktopPosition:null})}>Reset position</SettingsButton>
                <SettingsButton onClick={() => updateMascotSettings(DEFAULT_MASCOT_SETTINGS)}>Reset mascot settings</SettingsButton>
            </div>
            <SelectField label="Preview expression" aria-label="Preview expression" value={preview}
                onChange={event => { setPreview(event.target.value); setInstance(value => value + 1); }}>
                <option value="">No preview</option>
                {expressions.map(state => <option key={state} value={state}>{label(state)}</option>)}
            </SelectField>
            {active && preview && (
                <>
                    <div style={{ height: 160, width: 160, margin: 'auto' }}>
                        <MascotArtwork state={preview} id={`preview-${instance}`} size={160}
                            hue={settings.hue} reduced={reduced} direction={settings.facing} />
                    </div>
                    <div className="flex gap-3">
                        <SettingsButton onClick={() => setInstance(value => value + 1)}>Replay sequence</SettingsButton>
                        <SettingsButton onClick={() => setPreview('')}>End preview</SettingsButton>
                    </div>
                </>
            )}
            <SettingsHint>Reactions play into matching holds. Preview has no effect on task activity.
                Terminal and NAN keep their original facing to preserve symbols.</SettingsHint>
            {error && <p role="alert">Could not save mascot settings: {error}</p>}
        </SettingsCard>
    );
}
