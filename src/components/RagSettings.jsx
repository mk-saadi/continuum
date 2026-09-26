import React from "react";

export default function RagSettings() {
	return (
		<div className="mb-4 space-y-2 rounded-lg border border-[var(--border)] p-3">
			<h3 className="font-semibold">Offline document chat</h3>
			<p>Documents are indexed locally using all-MiniLM-L6-v2. Document text stays on this computer.</p>
			<p className="palace-hint">
				The embedding model downloads on first use and is cached for offline use. PDFs need a text
				layer; OCR is not included.
			</p>
		</div>
	);
}
