'use strict';
const fs = require('node:fs');
const path = require('node:path');

const isProjector = name => /mmproj.*\.gguf$/i.test(name);

// Grow only when the parser needs more bytes; never read unbounded model weights.
async function readGguf(filePath, size) {
    const { ggufMetadata } = await import('hyllama');
    const limit = Math.min(size, 64 * 1024 * 1024);
    const fd = fs.openSync(filePath, 'r');
    try {
        for (let length = Math.min(limit, 1024 * 1024); ; length = Math.min(limit, length * 2)) {
            const buffer = new Uint8Array(length);
            let read = 0;
            while (read < length) {
                const count = fs.readSync(fd, buffer, read, length - read, read);
                if (!count) break;
                read += count;
            }
            if (read < 24 || Buffer.from(buffer.subarray(0, 4)).toString() !== 'GGUF') throw new Error('Invalid GGUF header.');
            try { return ggufMetadata(buffer.buffer.slice(0, read)); }
            catch (error) {
                if (!(error instanceof RangeError) || length === limit) throw error;
            }
        }
    } finally { fs.closeSync(fd); }
}
const positiveInteger = value => Number.isSafeInteger(value) && value > 0 ? value : null;

async function parseModelMetadata(filePath, fileName, stats, projectors) {
	// The scanner supplies its directory snapshot to avoid repeated reads.
	projectors ??= fs.readdirSync(path.dirname(filePath), { withFileTypes: true })
		.filter(entry => entry.isFile() && isProjector(entry.name));
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const unit = stats.size > 0 ? Math.min(Math.floor(Math.log(stats.size) / Math.log(1024)), units.length - 1) : 0;
	const result = {
		fileIdentity: { size: stats.size, mtimeMs: stats.mtimeMs ?? null },
		reasoningFormat: 'auto',
		reasoningEfforts: [],
		supportsReasoningEffort: null,
		supportsReasoningBudget: null,
		supportsDisableReasoning: null,
		architecture: null,
		expertCount: null,
        activeExpertCount: null, contextLength: null, layerCount: null, embeddingLength: null, attentionHeads: null, kvHeads: null, expertLayers: null, metadataStatus: 'unknown', metadataError: null,
        keyLength: null, valueLength: null, fullAttentionInterval: null,
		isMoe: false,
		sizeFormatted: `${(stats.size / 1024 ** unit).toFixed(2)} ${units[unit]}`,
		quantization: fileName.match(/(?:IQ\d+_[A-Z0-9_]+|Q\d+_[A-Z0-9_]+|BF16|F16|F32)(?=[.-]|$)/i)?.[0].toUpperCase() || null,
		paramSize: fileName.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?B)(?=[^a-z0-9]|$)/i)?.[1].toUpperCase() || null,
		hasVision: /vl|vision|llava|gemma[-_.]?4/i.test(fileName),
		hasTools: /instruct|hermes|qwen[-_.]?2\.5|gemma[-_.]?4|llama[-_.]?3|tool/i.test(fileName),
		hasReasoning: /deepseek[-_.]r1|qwq|think|reasoning|marco[-_.]o1/i.test(fileName),
	};
	try {
		const { metadata, tensorInfos } = await readGguf(filePath, stats.size);
        result.metadataStatus = 'parsed';
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
		// The installed llama-server only enforces a numeric budget when the
		// chat template exposes reasoning end tags. This is model/template
		// dependent, never a universal local capability.
		const REASONING_END_TAG = /<\/think>|\[\/THINK\]|<\/mm:think>|<channel\|>|<\|close\|>think<\|sep\|>|<\|END_THINKING\|>/i;
		result.supportsReasoningBudget = REASONING_END_TAG.test(chatTemplate);
		result.supportsReasoningEffort = result.reasoningEfforts.length > 0
			|| /reasoning_effort/.test(chatTemplate);
		result.supportsDisableReasoning = result.supportsReasoningEffort
			|| result.supportsReasoningBudget
			|| /enable_thinking|thinking\s*==/i.test(chatTemplate);
		const arch = typeof metadata['general.architecture'] === 'string' ? metadata['general.architecture'] : '';
		result.architecture = arch || null;
		// Expert metadata is only present for MoE GGUFs; reuse the header already parsed here.
		result.expertCount = Number.isSafeInteger(metadata[`${arch}.expert_count`])
			? metadata[`${arch}.expert_count`] : null;
        for (const [field, key] of Object.entries({ contextLength: 'context_length', layerCount: 'block_count', activeExpertCount: 'expert_used_count', embeddingLength: 'embedding_length', attentionHeads: 'attention.head_count', kvHeads: 'attention.head_count_kv', keyLength: 'attention.key_length', valueLength: 'attention.value_length', fullAttentionInterval: 'full_attention_interval' })) result[field] = positiveInteger(metadata[`${arch}.${key}`]);
        const expertLayers = [...new Set(tensorInfos.filter(t => /ffn_(?:gate|up|down)_exps/.test(t.name)).map(t => t.name.match(/^blk\.(\d+)\./)?.[1]).filter(value => value !== undefined).map(Number))].sort((a, b) => a - b);
        result.expertLayers = expertLayers.length ? expertLayers : null;
        result.hasAudio = metadata['clip.has_audio_encoder'] === true || Object.keys(metadata).some(key => /(?:^|\.)audio_encoder\./i.test(key));

		result.isMoe = result.expertCount !== null || metadata[`${arch}.expert_used_count`] !== undefined;
		result.hasTools ||= /<tools>|tool_calls/.test(chatTemplate);
		result.hasReasoning ||= /<think>/.test(chatTemplate) || /deepseek/i.test(arch);
		result.hasVision ||= /vl|vision|llava|mllama|gemma3|gemma4|pixtral|idefics|minicpmv/i.test(arch)
			|| metadata['clip.has_vision_encoder'] === true
			|| Object.keys(metadata).some(key => /(?:^|\.)(?:vision|vision_encoder)\./i.test(key));
	} catch (err) {
        result.metadataError = err.message;
		console.warn(`Failed to parse GGUF header for ${fileName}:`, err.message);
	}
    result.declaredCapabilities = {
        source: 'inferred', image: result.hasVision ? true : null, audio: result.hasAudio ? true : null, video: null,
    };
	return result;
}

async function scanDirectoryForModels(dir) {
	const models = [];
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const projectors = entries.filter(entry => entry.isFile() && isProjector(entry.name));
        const projectorCandidates = await Promise.all(projectors.map(async entry => {
            const projectorPath = path.resolve(dir, entry.name);
            try {
                const stats = fs.statSync(projectorPath);
                const { metadata } = await readGguf(projectorPath, stats.size);
                return { path: projectorPath, name: entry.name, fileIdentity: { size: stats.size, mtimeMs: stats.mtimeMs }, architecture: metadata['general.architecture'] || null,
                    image: typeof metadata['clip.has_vision_encoder'] === 'boolean' ? metadata['clip.has_vision_encoder'] : null,
                    audio: typeof metadata['clip.has_audio_encoder'] === 'boolean' ? metadata['clip.has_audio_encoder'] : null };
            } catch (error) { return { path: projectorPath, name: entry.name, error: error.message }; }
        }));
		for (const entry of entries) {
			const fullPath = path.resolve(dir, entry.name);
			if (entry.isDirectory()) {
				models.push(...await scanDirectoryForModels(fullPath));
			} else if (entry.isFile() && /\.gguf$/i.test(entry.name) && !isProjector(entry.name)) {
				try {
					const matches = projectors.filter(projector =>
						projector.name.replace(/[-_.]?mmproj[-_.]?/i, '').toLowerCase() === entry.name.toLowerCase());
					// Multiple unmatched projectors are ambiguous; do not choose an arbitrary one.
					const projector = matches.length === 1 ? matches[0] : null;
					const metadata = await parseModelMetadata(fullPath, entry.name, fs.statSync(fullPath), projectors);
					models.push({
						id: fullPath, name: `${path.basename(dir)}/${entry.name}`, path: fullPath, modelPath: fullPath,
						...metadata, isVision: metadata.hasVision, hasVisionProjector: !!projector,
						projectorCandidates,
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

module.exports = { scanDirectoryForModels, parseModelMetadata, readGguf };
