import React, { useEffect, useState } from "react";
import { subagentLimitNotice } from "../../lib/subagentDisplay.mjs";

// Small amber label beside "Show sub-agent activity" when the child stopped
// on a tool-call, model-request, or parent-run limit. Fetches the saved
// transcript once; renders nothing while loading or when no limit was hit.
export default function SubagentLimitBadge({ childSessionId }) {
	if (typeof childSessionId !== "string" || !childSessionId) return null;
	const [notice, setNotice] = useState(null);
	useEffect(() => {
		let active = true;
		window.api?.getChildTranscript?.(childSessionId)
			.then((transcript) => {
				if (active) setNotice(subagentLimitNotice(transcript));
			})
			.catch(() => {
				if (active) setNotice(null);
			});
		return () => {
			active = false;
		};
	}, [childSessionId]);
	if (!notice) return null;
	return (
		<span
			title={notice}
			className="shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500"
		>
			Limit hit — raise in Settings › Agents &amp; Skills › Custom hard limits
		</span>
	);
}
