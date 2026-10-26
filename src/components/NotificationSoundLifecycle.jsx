import { useEffect } from 'react';
import { notificationSounds, subscribeNotificationSounds } from '../lib/notificationSounds.mjs';

export default function NotificationSoundLifecycle() {
  useEffect(() => {
    let active = true;
    notificationSounds.activate();
    window.api?.getAppSettings().then(settings => {
      if (active) notificationSounds.setPrefs(settings.notificationSounds);
    }).catch(() => {});
    const unsubscribe = subscribeNotificationSounds(window.chatAPI);
    const shutdown = () => notificationSounds.dispose();
    window.addEventListener('pagehide', shutdown);
    return () => { active = false; unsubscribe(); notificationSounds.dispose(); window.removeEventListener('pagehide', shutdown); };
  }, []);
  return null;
}
