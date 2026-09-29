import { useEffect, useRef, useState } from 'react';

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
  const pending = useRef(Promise.resolve());
  const [error, setError] = useState('');
  useEffect(() => {
    if (!window.api?.getAvatarSettings) return;
    pending.current = window.api.getAvatarSettings().then(async saved => {
      const value = saved ?? current.current;
      if (!saved) await window.api.saveAvatarSettings(value);
      current.current = value;
      setSettings(value);
      // The DB now owns the data; legacy browser storage is no longer needed.
      localStorage.removeItem(STORAGE_KEY);
    }).catch(error => { setError(error.message); });
  }, []);
  const update = patch => {
    const operation = pending.current.then(async () => {
      const next = { ...current.current, ...(typeof patch === 'function' ? patch(current.current) : patch) };
      if (window.api?.saveAvatarSettings) await window.api.saveAvatarSettings(next);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      current.current = next;
      setSettings(next);
      setError('');
    });
    pending.current = operation.catch(() => {});
    return operation;
  };
  return { settings, update, error };
}
