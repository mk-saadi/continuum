// Renderer-facing cost formatting.
//
// This module is imported by browser code, so it cannot import the CommonJS
// pricing module directly: Vite's dev server serves project `.cjs` files as-is
// and does not provide an ESM default/named export for them. Keep these tiny
// presentation helpers here and mirror cloudPricing.cjs exactly. The backend
// estimator remains the single source of truth for pricing itself.
//
// A deterministic parity test compares these formatters with
// cloudPricing.cjs so the two copies cannot drift silently.

export function formatUsd(value) {
	if (value === null || value === undefined || !Number.isFinite(value)) return '—';
	const magnitude = Math.abs(value);
	if (magnitude === 0) return '$0.00';
	if (magnitude < 0.0001) return '< $0.0001';
	if (magnitude < 0.01) return `$${value.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')}`;
	if (magnitude < 1) return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
	return `$${value.toFixed(2)}`;
}

export function formatSignedUsd(value) {
	if (value === null || value === undefined || !Number.isFinite(value)) return '—';
	const formatted = formatUsd(Math.abs(value));
	if (value > 0) return `+${formatted}`;
	if (value < 0) return `-${formatted}`;
	return formatted;
}

// Coverage/completeness wording shared by Token History, Token Chart and the
// per-message cost chip. Kept here so no surface invents its own labels.
export function costCoverageLabel(coverage) {
	if (coverage === 'measured') return 'measured';
	if (coverage === 'partially_measured') return 'known subtotal';
	if (coverage === 'not_applicable') return 'not applicable';
	return 'unavailable';
}

// A compact one-line cost summary for the per-message footer. Never shows
// "$0.00 operating cost" for a local model: a local turn has no cloud charge
// at all, which is a different statement from a measured zero.
export function costChipText(cost) {
	if (!cost) return null;
	if (cost.completeness === 'not_applicable') return 'Cloud cost n/a (local)';
	if (typeof cost.total === 'number') return `${formatUsd(cost.total)}${cost.completeness === 'partial' ? ' (partial)' : cost.estimated || cost.completeness === 'estimated' ? ' (estimated)' : ''}`;
	if (cost.providerReported != null) return formatUsd(cost.providerReported);
	return 'Cost unavailable';
}
