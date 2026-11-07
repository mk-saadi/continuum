const IMAGE_EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

export function composerFileName(file) {
  if (file.name?.includes('.')) return file.name;
  return IMAGE_EXTENSIONS[file.type] ? `${file.name || 'pasted-image'}${IMAGE_EXTENSIONS[file.type]}` : file.name;
}

// FileReader reads the encoded source, without canvas, decoding, resizing,
// flattening, or re-encoding. It also works for clipboard Blobs without paths.
export async function prepareComposerFiles(files) {
  const originals = [];
  for (const file of files) {
    const name = composerFileName(file);
    if (!/\.(png|jpe?g|webp)$/i.test(name || '')) { originals.push(file); continue; }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`Could not read ${name}. Select the image again.`));
      reader.onabort = () => reject(new Error(`Reading ${name} was cancelled. Select the image again.`));
      reader.readAsDataURL(file);
    });
    // Disk files may have no browser MIME. The main process verifies the
    // declared format against decoded bytes before saving either representation.
    const type = IMAGE_EXTENSIONS[file.type] ? file.type : /\.png$/i.test(name) ? 'image/png'
      : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
    originals.push({ name, type, size: file.size, lastModified: file.lastModified,
      dataUrl: dataUrl.replace(/^data:[^;]*;base64,/, `data:${type};base64,`) });
  }
  return originals;
}
