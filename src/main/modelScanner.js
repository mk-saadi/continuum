'use strict';
const fs = require('node:fs');
const path = require('node:path');

const isProjector = name => /mmproj.*\.gguf$/i.test(name);

async function parseModelMetadata(filePath, fileName, stats, projectors) {
	// The scanner supplies its directory snapshot to avoid repeated reads.
	projectors ??= fs.readdirSync(path.dirname(filePath), { withFileTypes: true })
		.filter(entry => entry.isFile() && isProjector(entry.name));
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const unit = stats.size > 0 ? Math.min(Math.floor(Math.log(stats.size) / Math.log(1024)), units.length - 1) : 0;
	const result = {
		reasoningFormat: 'auto',
		reasoningEfforts: [],
		sizeFormatted: `${(stats.size / 1024 ** unit).toFixed(2)} ${units[unit]}`,
		quantization: fileName.match(/(?:IQ\d+_[A-Z0-9_]+|Q\d+_[A-Z0-9_]+|BF16|F16|F32)(?=[.-]|$)/i)?.[0].toUpperCase() || null,
		paramSize: fileName.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?B)(?=[^a-z0-9]|$)/i)?.[1].toUpperCase() || null,
		hasVision: /vl|vision|llava|gemma[-_.]?4/i.test(fileName) || projectors.length > 0,
		hasTools: /instruct|hermes|qwen[-_.]?2\.5|gemma[-_.]?4|llama[-_.]?3|tool/i.test(fileName),
		hasReasoning: /deepseek[-_.]r1|qwq|think|reasoning|marco[-_.]o1/i.test(fileName),
	};
	try {
		const { ggufMetadata } = await import('hyllama');
		const fd = fs.openSync(filePath, 'r');
		let header;
		try {
			const buffer = new Uint8Array(Math.min(stats.size, 5 * 1024 * 1024));
			let bytesRead = 0;
			while (bytesRead < buffer.length) {
				const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
				if (!count) break;
				bytesRead += count;
			}
			header = buffer.buffer.slice(0, bytesRead);
		} finally {
			fs.closeSync(fd);
		}
		const { metadata } = ggufMetadata(header);
		// Named templates are also used by GGUF exporters (e.g. chat_template.tool_use).
		const chatTemplate = Object.entries(metadata)
			.filter(([key, value]) => /^tokenizer\.chat_template(?:\.|$)/.test(key) && typeof value === 'string')
			.map(([, value]) => value).join('\n');
		result.generalName = typeof metadata['general.name'] === 'string' ? metadata['general.name'] : null;
		result.chatTemplate = chatTemplate;
		const efforts = chatTemplate.match(/reasoning_effort\s*==\s*['"](.*?)['"]/g)
			?.map(match => match.match(/['"](.*?)['"]/)[1]) || [];
		result.reasoningEfforts = [...new Set(efforts)].filter(Boolean);
		result.hasReasoning ||= result.reasoningEfforts.length > 0;
		result.reasoningFormat = chatTemplate.includes('<think>') ? 'deepseek' : 'auto';
		result.hasReasoning ||= /deepseek|qwq|think|reasoning/i.test(result.generalName || '');
		const arch = typeof metadata['general.architecture'] === 'string' ? metadata['general.architecture'] : '';
		result.hasTools ||= /<tools>|tool_calls/.test(chatTemplate);
		result.hasReasoning ||= /<think>/.test(chatTemplate) || /deepseek/i.test(arch);
		result.hasVision ||= /vl|vision|llava|mllama|gemma3|gemma4|pixtral|idefics|minicpmv/i.test(arch)
			|| metadata['clip.has_vision_encoder'] === true
			|| Object.keys(metadata).some(key => /(?:^|\.)(?:vision|vision_encoder)\./i.test(key));
	} catch (err) {
		console.warn(`Failed to parse GGUF header for ${fileName}:`, err.message);
	}
	return result;
}

async function scanDirectoryForModels(dir) {
	const models = [];
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const projectors = entries.filter(entry => entry.isFile() && isProjector(entry.name));
		for (const entry of entries) {
			const fullPath = path.resolve(dir, entry.name);
			if (entry.isDirectory()) {
				models.push(...await scanDirectoryForModels(fullPath));
			} else if (entry.isFile() && /\.gguf$/i.test(entry.name) && !isProjector(entry.name)) {
				try {
					const matches = projectors.filter(projector =>
						projector.name.replace(/[-_.]?mmproj[-_.]?/i, '').toLowerCase() === entry.name.toLowerCase());
					// Multiple unmatched projectors are ambiguous; do not choose an arbitrary one.
					const projector = matches.length === 1 ? matches[0] : projectors.length === 1 ? projectors[0] : null;
					const metadata = await parseModelMetadata(fullPath, entry.name, fs.statSync(fullPath), projectors);
					models.push({
						id: fullPath, name: `${path.basename(dir)}/${entry.name}`, path: fullPath, modelPath: fullPath,
						...metadata, isVision: metadata.hasVision, hasVisionProjector: !!projector,
						mmprojPath: projector ? path.resolve(dir, projector.name) : null,
					});
				} catch (err) {
					console.error(`[scanLocalModels] Error reading model ${fullPath}:`, err.message);
				}
			}
		}
	} catch (err) {
		console.error(`[scanLocalModels] Error reading directory ${dir}:`, err.message);
	}
	return models;
}

module.exports = { scanDirectoryForModels, parseModelMetadata };
