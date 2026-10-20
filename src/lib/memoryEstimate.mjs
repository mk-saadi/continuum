// Shared, dependency-free memory estimator for local model loading.
//
// This is the single source of truth for two consumers:
//   * the main-process GPU preflight (`src/main/gpuMemory.js` re-exports it), and
//   * the live VRAM / system-RAM estimate shown in the model load modal.
//
// Every number is a rough approximation derived from GGUF metadata and file
// sizes. It excludes OS, driver, allocator, and page-cache overhead; the
// runtime's own startup log remains the source of truth for what a load
// actually did. Nothing here may throw into the load path.

const MIB = 1024 * 1024;

// Bytes per KV-cache element. Half-precision types are 2 bytes; quantized types
// store 32 weights per block (q8_0 = 34 bytes, q4_0 = 18 bytes, ...). Unknown
// types fall back to f16 so an unrecognized value never looks cheaper than it is.
const KV_BYTES_PER_ELEMENT = Object.freeze({
	f32: 4,
	f16: 2,
	bf16: 2,
	q8_0: 34 / 32,
	q5_1: 24 / 32,
	q5_0: 22 / 32,
	q4_1: 20 / 32,
	q4_0: 18 / 32,
	iq4_nl: 18 / 32,
});

export function kvElementBytes(type) {
	return KV_BYTES_PER_ELEMENT[type] ?? 2;
}

function positiveInteger(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// `-ngl` semantics: "auto" (or absent) asks for as many layers as fit; a number
// requests exactly that many repeating layers, with the output layer on top.
function resolveOffload(config, layerCount) {
	const notes = [];
	const requested = config.gpuOffload;
	const fullRequest = requested === "auto" || requested === undefined || requested === null;
	let offloadFraction = 1;
	if (!fullRequest) {
		const requestedLayers = Number(requested);
		if (!Number.isFinite(requestedLayers) || requestedLayers < 0) {
			notes.push("gpu-offload-invalid");
			offloadFraction = 0;
		} else if (layerCount) {
			offloadFraction = Math.min(1, requestedLayers / (layerCount + 1));
		} else {
			offloadFraction = requestedLayers > 0 ? 1 : 0;
		}
	}
	return {
		requested,
		fullRequest,
		offloadFraction,
		expectedFullOffload: fullRequest || offloadFraction === 1,
		notes,
	};
}

// KV cache holds one K and one V value per (attention layer, kv head, context
// token). Hybrid models (SSM + attention, or periodic full attention) only keep
// KV for their attention layers, and some architectures store explicit
// key/value head dimensions instead of deriving them from the embedding size —
// both are honored when present.
function estimateKvMiB(model, config, layerCount) {
	const notes = [];
	const kvOffloaded = config.kvCacheOffload !== "cpu";
	const headCount = positiveInteger(model.attentionHeads);
	const kvHeads = positiveInteger(model.kvHeads) ?? headCount;
	const embeddingLength = positiveInteger(model.embeddingLength);
	const derivedHeadDim = headCount && embeddingLength ? embeddingLength / headCount : null;
	const keyLength = positiveInteger(model.keyLength) ?? derivedHeadDim;
	const valueLength = positiveInteger(model.valueLength) ?? derivedHeadDim;
	const interval = positiveInteger(model.fullAttentionInterval);
	const kvLayers = layerCount && interval && interval > 1 ? Math.ceil(layerCount / interval) : layerCount;
	const contextLength = positiveInteger(config.contextLength);
	let kvSizeMiB = null;
	if (kvLayers && kvHeads && keyLength && valueLength && contextLength) {
		const perToken =
			kvHeads * (keyLength * kvElementBytes(config.cacheTypeK) + valueLength * kvElementBytes(config.cacheTypeV));
		kvSizeMiB = (kvLayers * perToken * contextLength) / MIB;
	} else if (kvOffloaded) {
		// Only the GPU view needs the size; an unknown shape is irrelevant to VRAM
		// when the cache is placed on the CPU.
		notes.push("kv-shape-unknown");
	}
	return { kvOffloaded, kvSizeMiB, notes };
}

// Split a load's expected memory between GPU VRAM and system RAM. Returns
// `vramMiB`/`ramMiB` as `null` when the weights (the dominant term) are unknown.
export function estimateMemoryUsage({ model = {}, config = {}, projectorBytes = null } = {}) {
	const notes = [];
	const layerCount = positiveInteger(model.layerCount);
	const weightBytes =
		Number.isFinite(model.fileIdentity?.size) && model.fileIdentity.size > 0
			? model.fileIdentity.size
			: null;
	if (!weightBytes) notes.push("model-size-unknown");
	if (!layerCount) notes.push("layer-count-unknown");

	const offload = resolveOffload(config, layerCount);
	notes.push(...offload.notes);

	const weightsVramMiB = weightBytes === null ? null : (weightBytes * offload.offloadFraction) / MIB;
	const weightsRamMiB = weightBytes === null ? null : (weightBytes * (1 - offload.offloadFraction)) / MIB;

	const kv = estimateKvMiB(model, config, layerCount);
	notes.push(...kv.notes);
	const kvVramMiB = kv.kvOffloaded ? kv.kvSizeMiB : 0;
	const kvRamMiB = kv.kvOffloaded ? 0 : kv.kvSizeMiB;

	// Compute/graph buffers are not derivable from metadata; treat a bounded
	// fraction of the offloaded weights as an empirical heuristic.
	const computeMiB =
		weightsVramMiB === null ? null : Math.min(4096, Math.max(256, Math.round(weightsVramMiB * 0.07)));

	// The multimodal projector lives on the GPU by default; when the user keeps
	// it on the CPU its size moves to the RAM column.
	const projectorOffloaded = config.mmprojOffload !== false;
	const projectorTotalMiB =
		Number.isFinite(projectorBytes) && projectorBytes > 0 ? projectorBytes / MIB : null;
	const projectorVramMiB = projectorOffloaded ? projectorTotalMiB : 0;
	const projectorRamMiB = projectorOffloaded ? 0 : projectorTotalMiB;
	if (model.mmprojPath && projectorOffloaded && projectorVramMiB === null)
		notes.push("projector-size-unknown");

	const vramMiB =
		weightsVramMiB === null
			? null
			: Math.round((weightsVramMiB || 0) + (kvVramMiB || 0) + (computeMiB || 0) + (projectorVramMiB || 0));

	// A CPU-placed projector or KV cache with an unknown size makes the RAM total
	// a lower bound, so report it as unknown rather than silently understate it.
	const ramIncomplete =
		weightsRamMiB === null || kvRamMiB === null || (!projectorOffloaded && projectorTotalMiB === null);
	const ramMiB = ramIncomplete
		? null
		: Math.round((weightsRamMiB || 0) + (kvRamMiB || 0) + (projectorRamMiB || 0));

	// Confidence describes how complete the estimate is, not how precise it is:
	// even a "high" estimate is still a heuristic. It tracks the VRAM view, which
	// is what the load preflight acts on.
	const confidence =
		weightsVramMiB === null
			? "low"
			: kvVramMiB === null || (model.mmprojPath && projectorVramMiB === null)
				? "medium"
				: "high";

	return {
		expectedFullOffload: offload.expectedFullOffload,
		requestedLayers: offload.fullRequest ? "all" : Number(offload.requested),
		vramMiB,
		ramMiB,
		ramIncomplete,
		confidence,
		notes,
		components: {
			weightsVramMiB,
			weightsRamMiB,
			kvVramMiB,
			kvRamMiB,
			computeMiB,
			projectorVramMiB,
			projectorRamMiB,
		},
	};
}
