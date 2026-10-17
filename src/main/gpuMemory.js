"use strict";

// Advisory GPU-memory assessment for local model loading.
//
// Everything here is best-effort. Requirements are estimated from GGUF
// metadata and file sizes, so the numbers are approximations, not contracts.
// The runtime's own startup log is the source of truth for what actually
// happened (see `parseOffloadDiagnostics` / `evaluateOffloadResult`). Nothing
// in this module may throw into the load path, and no estimate is allowed to
// become a hard failure on its own.
//
// Uncertainty is handled in three ways:
//   * `estimateOffloadRequirements` reports a `confidence` level and never
//     fabricates a total it cannot support (`totalMiB: null`).
//   * `assessGpuFit` returns `status: "unknown"` whenever the estimate or the
//     GPU reading is unavailable, so callers stay silent instead of guessing.
//   * The preflight cannot know what another process may allocate between the
//     reading and the load, so the post-load log check always takes precedence
//     and is the only place a partial offload is asserted.

const MIB = 1024 * 1024;

// Reserved free VRAM after a load before we consider the fit "comfortable".
// This deliberately mirrors llama.cpp's own reserve: the server's auto-fit
// (`-ngl auto`) reduces offload when it cannot leave this much free, so using
// the same number keeps the preflight prediction aligned with what the runtime
// will actually decide.
const DEFAULT_SAFETY_MARGIN_MIB = 1024;

// Bytes per KV-cache element. Half-precision types are 2 bytes; quantized
// types store 32 weights per block (q8_0 = 34 bytes, q4_0 = 18 bytes, ...).
// Unknown types fall back to f16 so an unrecognized value never looks cheaper
// than it is.
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

function kvElementBytes(type) {
	return KV_BYTES_PER_ELEMENT[type] ?? 2;
}

// `nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader,nounits`
function parseGpuQueryOutput(text) {
	const devices = [];
	for (const line of String(text ?? "").split(/\r?\n/)) {
		const parts = line.split(",").map((part) => part.trim());
		if (parts.length < 4) continue;
		const index = Number(parts[0]);
		const totalMiB = Number(parts[2]);
		const freeMiB = Number(parts[3]);
		if (!Number.isFinite(totalMiB) || !Number.isFinite(freeMiB)) continue;
		devices.push({
			index: Number.isFinite(index) ? index : devices.length,
			name: parts[1] || "GPU",
			totalMiB,
			freeMiB,
		});
	}
	return devices;
}

// Never rejects. A missing tool, an unsupported platform, or a driver error
// all resolve to `{ available: false }` so the caller degrades to "unknown"
// instead of blocking the load.
async function queryGpuMemory({ execFileImpl } = {}) {
	const exec = execFileImpl ?? require("node:child_process").execFile;
	if (typeof exec !== "function") return { available: false, reason: "gpu-query-unavailable" };
	try {
		const stdout = await new Promise((resolve, reject) => {
			exec(
				"nvidia-smi",
				["--query-gpu=index,name,memory.total,memory.free", "--format=csv,noheader,nounits"],
				{ timeout: 4000, windowsHide: true, maxBuffer: MIB },
				(error, output) => (error ? reject(error) : resolve(output)),
			);
		});
		const devices = parseGpuQueryOutput(stdout);
		if (!devices.length) return { available: false, reason: "gpu-query-empty" };
		return { available: true, devices };
	} catch (error) {
		return {
			available: false,
			reason: error?.code === "ENOENT" ? "gpu-query-missing" : "gpu-query-failed",
		};
	}
}

function positiveInteger(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// Estimate the GPU memory a load is expected to consume. Returns
// `totalMiB: null` only when the weights themselves are unknown; otherwise it
// sums whichever components it can and reports its confidence separately.
function estimateOffloadRequirements({ model = {}, config = {}, projectorBytes = null } = {}) {
	const notes = [];
	const layerCount = positiveInteger(model.layerCount);
	const weightBytes =
		Number.isFinite(model.fileIdentity?.size) && model.fileIdentity.size > 0
			? model.fileIdentity.size
			: null;
	if (!weightBytes) notes.push("model-size-unknown");
	if (!layerCount) notes.push("layer-count-unknown");

	// `-ngl` semantics: "auto" (or absent) asks for as many layers as fit;
	// a number requests exactly that many repeating layers, with the output
	// layer on top.
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
	const expectedFullOffload = fullRequest || offloadFraction === 1;

	const weightsMiB = weightBytes === null ? null : (weightBytes * offloadFraction) / MIB;

	// KV cache holds one K and one V value per (attention layer, kv head,
	// context token). Hybrid models (SSM + attention, or periodic full
	// attention) only keep KV for their attention layers, and some
	// architectures store explicit key/value head dimensions instead of
	// deriving them from the embedding size — both are honored when present.
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
	let kvMiB = null;
	if (!kvOffloaded) {
		kvMiB = 0;
	} else if (kvLayers && kvHeads && keyLength && valueLength && contextLength) {
		const perToken = kvHeads * (keyLength * kvElementBytes(config.cacheTypeK) + valueLength * kvElementBytes(config.cacheTypeV));
		kvMiB = (kvLayers * perToken * contextLength) / MIB;
	} else {
		notes.push("kv-shape-unknown");
	}

	// Compute/graph buffers are not derivable from metadata; treat a bounded
	// fraction of the weights as an empirical heuristic.
	const computeMiB =
		weightsMiB === null ? null : Math.min(4096, Math.max(256, Math.round(weightsMiB * 0.07)));

	const projectorMiB = Number.isFinite(projectorBytes) && projectorBytes > 0 ? projectorBytes / MIB : null;
	if (model.mmprojPath && projectorMiB === null) notes.push("projector-size-unknown");

	const totalMiB =
		weightsMiB === null
			? null
			: Math.round((weightsMiB || 0) + (kvMiB || 0) + (computeMiB || 0) + (projectorMiB || 0));

	// Confidence describes how complete the estimate is, not how precise it is:
	// even a "high" estimate is still a heuristic.
	const confidence =
		weightsMiB === null
			? "low"
			: kvMiB === null || (model.mmprojPath && projectorMiB === null)
				? "medium"
				: "high";

	return {
		expectedFullOffload,
		requestedLayers: fullRequest ? "all" : Number(requested),
		totalMiB,
		confidence,
		notes,
		components: { weightsMiB, kvMiB, computeMiB, projectorMiB },
	};
}

// Compare an estimate against current free memory. Advisory only.
function assessGpuFit({ estimate, memory, safetyMarginMiB = DEFAULT_SAFETY_MARGIN_MIB } = {}) {
	if (!estimate || estimate.totalMiB === null) return { status: "unknown", reason: "estimate-unavailable" };
	if (!memory?.available || !Array.isArray(memory.devices) || !memory.devices.length)
		return { status: "unknown", reason: memory?.reason || "gpu-query-unavailable" };
	const best = memory.devices.reduce((a, b) => (b.freeMiB > a.freeMiB ? b : a));
	const headroomMiB = best.freeMiB - estimate.totalMiB;
	return {
		status: headroomMiB >= safetyMarginMiB ? "sufficient" : "insufficient",
		estimatedMiB: estimate.totalMiB,
		freeMiB: best.freeMiB,
		headroomMiB,
		safetyMarginMiB,
		device: { index: best.index, name: best.name, totalMiB: best.totalMiB },
		components: estimate.components,
		confidence: estimate.confidence,
		notes: estimate.notes,
	};
}

// Explain a warning in terms of the comparison the user can actually check:
// the estimate versus free memory, the remaining headroom, and the margin that
// triggered the warning. Without stating the margin, a positive headroom reads
// as "it fits, why warn?".
function describeGpuFitWarning({ estimatedMiB, freeMiB, headroomMiB, safetyMarginMiB, device }) {
	const estimate = Math.round(estimatedMiB).toLocaleString();
	const free = freeMiB.toLocaleString();
	const name = device?.name ?? "this GPU";
	const situation =
		headroomMiB < 0
			? `but only ~${free} MiB is free on ${name} — about ~${Math.abs(Math.round(headroomMiB)).toLocaleString()} MiB short. `
			: `and ~${free} MiB is free on ${name} — but that leaves only ~${Math.round(headroomMiB).toLocaleString()} MiB of headroom, ` +
				`below the ~${Math.round(safetyMarginMiB).toLocaleString()} MiB safety margin the loader keeps free. `;
	return (
		`Estimated ~${estimate} MiB of GPU memory needed for full GPU offload, ${situation}` +
		`When it cannot keep that much free, the loader's auto-fit sheds GPU layers onto the CPU, which can significantly reduce generation speed. ` +
		`Free GPU memory (close other models or GPU-heavy apps), reduce the context size, or set GPU layers explicitly to the full count ` +
		`if the card has room, then reload — or continue anyway.`
	);
}

const GPU_DEVICE = "(?:GPU|CUDA\\d*|ROCm\\d*|Vulkan\\d*|Metal)";
const offloadedLine = () =>
	new RegExp(`(?:llm_)?load_tensors:\\s*offloaded\\s+(\\d+)\\s*/\\s*(\\d+)\\s+layers?\\s+to\\s+${GPU_DEVICE}`, "gi");
const offloadingRepeatingLine = () =>
	new RegExp(`(?:llm_)?load_tensors:\\s*offloading\\s+(\\d+)\\s+repeating\\s+layers?\\s+to\\s+${GPU_DEVICE}`, "gi");

function lastMatch(text, regex) {
	let match;
	let last = null;
	while ((match = regex.exec(text)) !== null) last = match;
	return last;
}

// Parse the fork's actual startup diagnostics. Prefers the authoritative
// "offloaded X/Y layers to GPU" summary; falls back to the repeating-layer
// count (with an unknown total) when only that line is present.
// Returns null when the log is silent or ambiguous.
function parseOffloadDiagnostics(text) {
	const source = String(text ?? "");
	const summary = lastMatch(source, offloadedLine());
	if (summary) return { offloaded: Number(summary[1]), total: Number(summary[2]) };
	const repeating = lastMatch(source, offloadingRepeatingLine());
	if (repeating) return { offloaded: Number(repeating[1]), total: null };
	return null;
}

function partialWarning({ offloaded, total, requestedLayers, resourceLimited }) {
	const counts = total === null ? `${offloaded} layers on GPU` : `${offloaded}/${total} layers on GPU`;
	const tail =
		`CPU-offloaded layers can significantly reduce generation speed. ` +
		`If the card has room, set GPU layers to the full count (${total}) instead of auto — ` +
		`the loader's auto-fit reduced offload on its own to keep a free-memory reserve. ` +
		`Otherwise free GPU memory (close other models or GPU-heavy apps) or reduce the context size, then reload.`;
	return {
		code: resourceLimited ? "gpu-offload-resource-limited" : "gpu-offload-partial",
		offloaded,
		total,
		message: resourceLimited
			? `The engine could only place ${counts}, fewer than the ${requestedLayers} you requested, because GPU memory ran out. ${tail}`
			: `The engine loaded the model with partial GPU offload (${counts}) even though full offload was requested. ${tail}`,
	};
}

// Decide what the runtime's diagnostics mean for this configuration.
//
//   full                      - every layer is on the GPU.
//   partial-unexpected        - partial offload under "auto" (or a request for
//                               all layers): a resource limitation.
//   partial-resource-limited  - fewer layers than explicitly requested.
//   partial-requested         - the user asked for fewer layers and got them.
//   unknown                   - diagnostics missing or ambiguous.
function evaluateOffloadResult({ diagnostics, gpuOffload, layerCount = null } = {}) {
	const isAuto = gpuOffload === "auto" || gpuOffload === undefined || gpuOffload === null;
	const requestedLayers = isAuto ? Infinity : Number(gpuOffload);
	const base = {
		offloaded: diagnostics?.offloaded ?? null,
		total: diagnostics?.total ?? null,
		requestedLayers: isAuto ? "all" : requestedLayers,
		expectedFullOffload:
			isAuto ||
			(Number.isFinite(requestedLayers) &&
				((diagnostics?.total != null && requestedLayers >= diagnostics.total) ||
					(diagnostics?.total == null && Number.isSafeInteger(layerCount) && requestedLayers >= layerCount + 1))),
	};
	// Ambiguous diagnostics must never be reported as either success or failure.
	if (!diagnostics || diagnostics.total == null) return { ...base, state: "unknown", warning: null };

	const { offloaded, total } = diagnostics;
	if (offloaded >= total) return { ...base, state: "full", warning: null };
	if (base.expectedFullOffload)
		return { ...base, state: "partial-unexpected", warning: partialWarning({ offloaded, total, requestedLayers: "all", resourceLimited: false }) };
	if (Number.isFinite(requestedLayers) && offloaded < Math.min(requestedLayers, total))
		return { ...base, state: "partial-resource-limited", warning: partialWarning({ offloaded, total, requestedLayers, resourceLimited: true }) };
	return { ...base, state: "partial-requested", warning: null };
}

// The advisory preflight is only meaningful for an automatic offload request.
// `-ngl auto` is an *unset* argument, so the loader's fit logic may silently
// reduce it to keep its reserve — and a silent reduction is exactly what the
// preflight warns about. An explicit layer count is a *set* argument that the
// fit logic refuses to touch, so a bad fit fails loudly (out of memory at load)
// rather than degrading quietly; warning beforehand would only risk talking the
// user out of a config that actually fits, as a manual `-ngl 999999` load on a
// card with under a gigabyte free demonstrates.
function shouldPreflightOffload(config) {
	const requested = config?.gpuOffload;
	return requested === "auto" || requested === undefined || requested === null;
}

module.exports = {
	DEFAULT_SAFETY_MARGIN_MIB,
	shouldPreflightOffload,
	kvElementBytes,
	parseGpuQueryOutput,
	queryGpuMemory,
	estimateOffloadRequirements,
	assessGpuFit,
	describeGpuFitWarning,
	parseOffloadDiagnostics,
	evaluateOffloadResult,
};
