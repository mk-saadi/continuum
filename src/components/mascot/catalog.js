import rows from '../../lib/mascotCatalog.json';
let urls = {};
// Non-Vite component fixtures can render settings without loading artwork.
try {
    urls = import.meta.glob('../../assets/mascot/*', { eager: true, query: '?url', import: 'default' });
}
catch { /* Asset playback requires the Vite renderer. */ }
export const expressions = [...new Set(rows.map(r => r.state))];
export const label = state => ({ 'error-nan': 'Technical issue (NAN)', 'error-xx': 'Request failed (X X)', 'error-spiral-clockwise': 'Spiral clockwise', 'error-spiral-opposite-directions': 'Spiral opposite directions', 'thinking-scan': 'Thinking scan' }[state] || state[0].toUpperCase() + state.slice(1));
export function clipFor(state, part, height = 128, dpr = 1) { const options = rows.filter(r => r.state === state && r.part === part).sort((a, b) => a.height - b.height); const r = options.find(r => r.height >= height * dpr) || options.at(-1); return r && { ...r, url: urls['../../assets/mascot/' + r.filename], staticUrl: urls['../../assets/mascot/' + r.static] }; }
const blobs = new Map();
export async function prepareClip(clip, reduced) {
    const source = reduced ? clip.staticUrl : clip.url;
    if (!source)
        throw Error('Missing mascot asset');
    let promise = blobs.get(source);
    if (!promise) {
        promise = fetch(source).then(r => { if (!r.ok)
            throw Error('Mascot asset unavailable'); return r.blob(); });
        blobs.set(source, promise);
        promise.catch(() => blobs.delete(source));
    }
    const url = URL.createObjectURL(await promise);
    const img = new Image();
    img.draggable = false;
    img.alt = '';
    img.dataset.playback = reduced ? 'static' : 'animated';
    img.src = url;
    try {
        await img.decode();
    }
    catch (e) {
        URL.revokeObjectURL(url);
        throw e;
    }
    return { img, dispose: () => URL.revokeObjectURL(url) };
}
