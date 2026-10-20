import React from "react";
import TurnOutcomes from "./chat/TurnOutcomes.jsx";

// Phase 2.1 follow-up: a completed reply shows what the user contributed while
// the run was executing. That is the steering instructions sent mid-run plus the
// resolved agent interactions they answered: the questions the agent asked and
// the skill-registration decisions they made. Steering instructions are not
// conversation turns, and none of these rows become chat messages; they are
// rendered here only for the run that produced the reply.
export default function AdditionalPrompts({ prompts = [], interactions = [] }) {
	const hasPrompts = Array.isArray(prompts) && prompts.length > 0;
	const hasInteractions = Array.isArray(interactions) && interactions.some(
		(entry) => entry && typeof entry === "object",
	);
	if (!hasPrompts && !hasInteractions) return null;
	return (
		<section
			aria-label="Additional prompts"
			className="mt-3 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2.5 text-xs"
		>
			<h3 className="font-semibold text-[var(--text-secondary)]">Additional prompts</h3>
			<p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
				{hasPrompts
					? "These steering instructions were sent while this task was running."
					: "These were recorded while this task was running."}
			</p>
			{hasPrompts && (
				<ol className="mt-2 list-decimal space-y-1.5 pl-4 leading-relaxed text-[var(--text-primary)]">
					{prompts.map((prompt) => (
						<li key={prompt.id} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
							{prompt.content}
						</li>
					))}
				</ol>
			)}
			{hasInteractions && <TurnOutcomes interactions={interactions} />}
		</section>
	);
}