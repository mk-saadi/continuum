export async function optimizeImage(file, maxWidth = 1024, maxHeight = 1024) {
  if (![maxWidth, maxHeight].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('Image bounds must be positive integers.');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(`Could not decode image: ${file.name}`));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Image has no dimensions.');
    const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image conversion is unavailable.');
    // JPEG has no alpha channel; composite transparent pixels onto white.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('JPEG conversion failed.');
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}
