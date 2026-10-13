import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import BackgroundSettings from '../../src/components/settings/BackgroundSettings';
import GeneralSettingsTab from '../../src/components/settings/GeneralSettingsTab';
import { SliderField } from '../../src/components/FormControls';
window.commits = [];
window.api = {
  getBackgroundSettings: async () => ({ imagePath: null, opacity: 80 }),
  setBackgroundOpacity: async opacity => { window.commits.push({ opacity }); await new Promise(resolve => setTimeout(resolve, 100)); return { imagePath: null, opacity }; },
  getAppSettings: async () => ({ maxConsecutiveToolFailures: 5, maxTotalToolFailures: 10 }),
  saveAppSettings: async patch => { window.commits.push(patch); await new Promise(resolve => setTimeout(resolve, 100)); return { maxConsecutiveToolFailures: 5, maxTotalToolFailures: 10, ...patch }; },
  getSubagentModel: async () => null,
  getCloudProviders: async () => [],
};
function Fixture() {
  const [value, setValue] = useState(50);
  window.sliderValue = value;
  return <div style={{ padding: 60, width: 500 }}><SliderField label="Test slider" valueLabel={value} min={0} max={100} value={value} onChange={event => setValue(Number(event.target.value))} /><BackgroundSettings /><GeneralSettingsTab /></div>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
