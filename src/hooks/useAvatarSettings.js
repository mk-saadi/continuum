import { useRef, useState } from 'react';

const STORAGE_KEY = 'avatar-settings';
export const DEFAULT_AVATAR_SETTINGS = { showAvatars: true, globalAvatarUrl: null, modelAvatars: {}, globalModelName: '', perModelNames: {} };

function readSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {
      showAvatars: typeof value?.showAvatars === 'boolean' ? value.showAvatars : true,
      globalAvatarUrl: typeof value?.globalAvatarUrl === 'string' ? value.globalAvatarUrl : null,
      globalModelName: typeof value?.globalModelName === 'string' ? value.globalModelName : '',
      perModelNames: Object.fromEntries(Object.entries(value?.perModelNames || {})
        .filter(([, name]) => typeof name === 'string')),
      modelAvatars: Object.fromEntries(Object.entries(value?.modelAvatars || {})
        .filter(([, url]) => typeof url === 'string' && url)),
    };
  } catch { return DEFAULT_AVATAR_SETTINGS; }
}

export default function useAvatarSettings() {
  const [settings, setSettings] = useState(readSettings);
  const current = useRef(settings);
  // Persist before updating the UI so storage failures can be shown by Settings.
  const update = patch => {
    const next = { ...current.current, ...(typeof patch === 'function' ? patch(current.current) : patch) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    current.current = next;
    setSettings(next);
  };
  return { settings, update };
}
