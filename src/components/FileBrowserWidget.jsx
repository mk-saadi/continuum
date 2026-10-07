import React, { useState } from 'react';
import { FiFolder, FiFile, FiCode, FiFileText, FiImage, FiFilm, FiExternalLink } from 'react-icons/fi';
import { localMediaUrl } from '../lib/directoryListing.mjs';

function sizeLabel(size) {
  if (typeof size === 'string') return size;
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${(size / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}

function FileCard({ item }) {
  const [failedPreview, setFailedPreview] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const folder = item.type === 'directory';
  const extension = item.path.split('.').pop().toLowerCase();
  const image = !folder && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension);
  const video = !folder && ['mp4', 'webm'].includes(extension);
  const Icon = folder ? FiFolder : image ? FiImage : video ? FiFilm :
    ['js', 'jsx', 'ts', 'tsx', 'json'].includes(extension) ? FiCode : extension === 'pdf' ? FiFileText : FiFile;
  async function open() {
    setOpening(true);
    setError('');
    try {
      if (!window.api?.openPath) throw new Error('Open this chat in the desktop app to open files.');
      await window.api.openPath(item.path);
    } catch (error) { setError(error.message || 'Could not open this item.'); }
    finally { setOpening(false); }
  }
  return (
    <li className="min-w-0">
      <button type="button" onClick={open} disabled={opening} title={item.path} aria-label={`Open ${item.name}`}
        className="group flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-xl border border-[var(--subtle-border)] bg-[var(--input)] text-left transition hover:border-[var(--accent)] hover:shadow-md focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-60">
        <div className={`relative flex h-24 w-full items-center justify-center overflow-hidden ${folder ? 'bg-amber-400/10 text-amber-500' : 'bg-slate-400/5 text-[var(--text-muted)]'}`}>
          {image && !failedPreview ? <img src={localMediaUrl(item.path)} alt="" loading="lazy" onError={() => setFailedPreview(true)} className="h-full w-full object-cover" /> :
            video && !failedPreview ? <video src={localMediaUrl(item.path)} muted playsInline preload="metadata" onError={() => setFailedPreview(true)}
              onLoadedMetadata={event => { if (event.currentTarget.duration > 0.1) event.currentTarget.currentTime = 0.1; }} className="h-full w-full object-cover" /> :
              <Icon aria-hidden="true" size={32} strokeWidth={1.4} />}
          {video && <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-white">VIDEO</span>}
          <FiExternalLink aria-hidden="true" className="absolute right-2 top-2 rounded bg-[var(--surface)] p-0.5 text-base opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" />
        </div>
        <div className="w-full space-y-1 p-2.5">
          <p className="truncate font-medium text-[var(--text-primary)]">{item.name}</p>
          <p className="truncate text-[10px] text-[var(--text-muted)]">{opening ? 'Opening…' : folder ? 'Folder' : [extension.toUpperCase(), sizeLabel(item.size)].filter(Boolean).join(' · ')}</p>
        </div>
      </button>
      {error && <p role="alert" className="mt-1 break-words text-[var(--error)]">{error}</p>}
    </li>
  );
}

export default function FileBrowserWidget({ items, notice }) {
  const folders = items.filter(item => item.type === 'directory').length;
  return (
    <section aria-label="Directory contents" className="space-y-3">
      <div className="flex items-center justify-between gap-2 text-[var(--text-muted)]">
        <span>{folders} folders · {items.length - folders} files</span><span className="text-[10px]">Click to open</span>
      </div>
      {items.length ? <ul className="grid max-h-96 grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 overflow-y-auto p-0.5">
        {items.map((item, index) => <FileCard key={`${item.path}:${index}`} item={item} />)}
      </ul> : <p className="py-6 text-center text-[var(--text-muted)]">This folder is empty.</p>}
      {notice && <p className="text-[var(--text-muted)]">{notice}</p>}
    </section>
  );
}
