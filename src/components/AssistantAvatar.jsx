import React, { useState } from 'react';
import { FaRobot } from 'react-icons/fa';

export default function AssistantAvatar({ settings, modelId }) {
  const [failedUrl, setFailedUrl] = useState(null);
  if (!settings.showAvatars) return null;
  const override = Object.hasOwn(settings.modelAvatars, modelId) ? settings.modelAvatars[modelId] : null;
  const url = override || settings.globalAvatarUrl;
  return <span className="inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--surface-hover)]" aria-hidden="true">
    {url && failedUrl !== url
      ? <img src={url} alt="" className="size-full object-cover" onError={() => setFailedUrl(url)} />
      : <FaRobot className="size-5 text-cyan-400" />}
  </span>;
}
