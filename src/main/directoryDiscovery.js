"use strict";

const fs = require('node:fs/promises');
const path = require('node:path');

// Search names, never reinterpret an absolute path or follow directory symlinks.
async function discoverDirectories(root, name, { signal, limit = 5000 } = {}) {
    if (typeof name !== 'string' || !name.trim() || /[/\\]/.test(name) || name === '.' || name === '..') {
        throw new Error('directory_name must be a single folder name, for example context.');
    }
    const ignored = new Set(['.git', 'node_modules']);
    const queue = ['.'];
    const matches = [];
    const skipped = [];
    let scanned = 0;
    while (scanned < queue.length && scanned < limit) {
        signal?.throwIfAborted();
        const relative = queue[scanned++];
        let entries;
        try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); }
        catch (error) {
            if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
            skipped.push(relative);
            continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const child = path.join(relative, entry.name);
            if (entry.name.toLowerCase() === name.trim().toLowerCase()) matches.push(child);
            if (!ignored.has(entry.name) && queue.length < limit + 1) queue.push(child);
        }
    }
    return { matches, truncated: scanned < queue.length, skipped, excluded_directories: [...ignored],
        guidance: 'Use a matching project-relative path as relative_path to list its entries. If multiple folders match, use context or ask the user to choose. Do not assume a missing match proves absence when truncated or skipped.' };
}

module.exports = { discoverDirectories };
