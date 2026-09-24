'use strict';
const fs = require('node:fs');
const path = require('node:path');

function scanDirectoryForModels(dir) {
	const models = [];
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const projectors = entries.filter(e => e.isFile() && /^mmproj.*\.gguf$/i.test(e.name));
		const weights = entries.filter(e => e.isFile() && /\.gguf$/i.test(e.name) && !/^mmproj/i.test(e.name));
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				// Recurse into subdirectories
				models.push(...scanDirectoryForModels(fullPath));
			} else if (entry.isFile()) {
				// Match .gguf files
				if (entry.name.toLowerCase().endsWith(".gguf") && !/^mmproj/i.test(entry.name)) {
					// Build a relative-style identifier: parentDir/filename
					const parentDir = path.basename(dir);
					const id = path.resolve(fullPath);
					const matches = projectors.filter(p => p.name.toLowerCase().replace(/^mmproj[-_.]?/, '') === entry.name.toLowerCase());
					const projector = matches.length === 1 ? matches[0] : (weights.length === 1 && projectors.length === 1 ? projectors[0] : null);
					models.push({ id, name: `${parentDir}/${entry.name}`, path: id, modelPath: id,
						isVision: !!projector, mmprojPath: projector ? path.resolve(dir, projector.name) : null });
				}
			}
		}
	} catch (err) {
		console.error(`[scanLocalModels] Error reading directory ${dir}:`, err.message);
	}
	return models;
}

module.exports = { scanDirectoryForModels };
