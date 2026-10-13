export const DOCUMENT_EXTENSIONS = ['.txt','.md','.csv','.pdf','.xlsx','.json','.js','.mjs','.cjs','.jsx','.ts','.tsx','.py','.html','.css','.xml','.yaml','.yml','.toml','.ini','.sh','.sql','.log','.tsv','.c','.h','.cpp','.java','.go','.rs','.rb','.php'];
export const MEDIA_EXTENSIONS = { image: ['.png','.jpg','.jpeg','.gif','.webp'], audio: ['.wav','.mp3'], video: ['.mp4','.webm','.mov','.mpeg','.mpg'] };
export function attachmentKind(name) {
  const extension = String(name).toLowerCase().match(/\.[^.\\/]+$/)?.[0];
  if (DOCUMENT_EXTENSIONS.includes(extension)) return 'document';
  return Object.keys(MEDIA_EXTENSIONS).find(kind => MEDIA_EXTENSIONS[kind].includes(extension)) || null;
}
export function attachmentPolicy(capabilities = {}, { local = false, apiType, service } = {}) {
  const enabled = {
    image: capabilities.image === true,
    audio: capabilities.audio === true && apiType !== 'anthropic',
    video: capabilities.video === true && (local || service === 'OpenRouter') && apiType !== 'anthropic',
  };
  const extensions = [...DOCUMENT_EXTENSIONS, ...Object.keys(enabled).filter(kind => enabled[kind]).flatMap(kind => MEDIA_EXTENSIONS[kind])];
  const labels = ['text files', 'PDF (extracted text)', 'Excel (.xlsx)'];
  for (const kind of Object.keys(enabled)) if (enabled[kind]) labels.unshift(kind === 'image' ? 'images' : kind);
  return { enabled, extensions, accept: extensions.join(','), tooltip: `Attach ${labels.join(', ')}. Media requires confirmed model support.` };
}
export function assertAttachmentNames(names, policy) {
  for (const name of names) {
    const kind = attachmentKind(name);
    if (!kind || kind !== 'document' && !policy.enabled[kind]) throw new Error(`Cannot attach ${name}: this file type is unsupported or unverified for the selected model.`);
  }
}
