import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { LuSlidersHorizontal, LuBrain } from "react-icons/lu";
import { CheckboxField, SelectField } from "./FormControls";
import { FaBolt, FaBrain, FaCog, FaInfinity } from "react-icons/fa";

// One capability-driven reasoning control. The main process resolves the saved
// intent against the actual model/provider, so this component never offers a
// control the target cannot honor and never guesses a wire field.
export function ReasoningSelector({ sessionId, modelId, activeChatProvider, disabled }) {
	const [capabilities, setCapabilities] = useState(null);
	const [effective, setEffective] = useState({ mode: "auto", effort: null, budget: null });
	const [warnings, setWarnings] = useState([]);
	const [customValue, setCustomValue] = useState("");
	const [ready, setReady] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [unknown, setUnknown] = useState(false);
	const revision = useRef(0);
	const provider = activeChatProvider?.type === "cloud" ? activeChatProvider : { type: "local" };

	useEffect(() => {
		let alive = true;
		const refresh = async () => {
			const request = ++revision.current;
			setReady(false);
			try {
				if (!window.api?.getReasoningCapabilities) {
					if (alive && request === revision.current) {
						setUnknown(true);
						setCapabilities(null);
						setReady(true);
					}
					return;
				}
				const result = await window.api.getReasoningCapabilities({
					sessionId, modelId, activeChatProvider: provider,
				});
				if (!alive || request !== revision.current) return;
				const next = result?.effective ?? { mode: "auto", effort: null, budget: null };
				setCapabilities(result ?? null);
				setEffective(next);
				setWarnings(Array.isArray(result?.warnings) ? result.warnings : []);
				setUnknown(false);
				if (next.mode === "budget") setCustomValue(String(next.budget));
				setError("");
				setReady(true);
			} catch (cause) {
				if (alive && request === revision.current) {
					setError(cause.message || "Could not read reasoning capabilities.");
					setReady(true);
				}
			}
		};
		if (modelId) void refresh();
		window.addEventListener("generation-settings-changed", refresh);
		return () => {
			alive = false;
			revision.current++;
			window.removeEventListener("generation-settings-changed", refresh);
		};
		// Primitive deps: the provider object is recreated by the renderer.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sessionId, modelId, provider.type, provider.provider, provider.model]);

	async function save({ thinkingBudget, reasoningEffort }) {
		const request = ++revision.current;
		setSaving(true);
		setError("");
		try {
			if (sessionId) {
				await window.api.saveSamplingParams(sessionId, modelId, {
					thinking_budget: thinkingBudget, reasoning_effort: reasoningEffort,
				});
			} else {
				await window.api.saveProfileSettings(modelId, { thinkingBudget, reasoningEffort });
			}
			if (request === revision.current) {
				setSaving(false);
				window.dispatchEvent(new Event("generation-settings-changed"));
			}
		} catch (cause) {
			if (request === revision.current) {
				setError(cause.message || "Could not save reasoning settings.");
				setSaving(false);
			}
		}
	}

	const canDisable = capabilities?.canDisable === true;
	const efforts = Array.isArray(capabilities?.efforts) ? capabilities.efforts : [];
	const budget = capabilities?.budget ?? { supported: null, min: null, max: null };
	const budgetSupported = budget.supported === true;
	const noControl = capabilities && capabilities.reasoning === false;
	const controlsKnown = canDisable || efforts.length > 0 || budgetSupported;
	if (!modelId || unknown || (!controlsKnown && !noControl && ready && !capabilities?.reasoning)) {
		const label = noControl ? "Unavailable" : "Unknown";
		return (
			<div className="w-full rounded-lg border border-[var(--subtle-border)] bg-[var(--input)] px-2.5 py-2">
				<div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)]">
					<FaBrain /> Reasoning: {label}
				</div>
				<p className="mt-1 text-[10px] leading-snug text-[var(--text-muted)]">
					{noControl
						? "This model does not expose reasoning controls."
						: "This model does not report reasoning controls; the provider default is used."}
				</p>
			</div>
		);
	}

	const items = [{ value: "auto", label: "Automatic", description: "Model default", icon: <FaInfinity /> }];
	if (canDisable) items.push({ value: "off", label: "Off", description: "No hidden reasoning", icon: <FaBolt /> });
	for (const effort of efforts) {
		items.push({ value: `effort:${effort}`, label: effort[0].toUpperCase() + effort.slice(1),
			description: "effort", icon: <FaBrain /> });
	}
	if (budgetSupported) {
		items.push({ value: "budget", label: "Custom budget", description: "token cap", icon: <FaCog /> });
	}

	const selected = effective.mode === "off" ? "off"
		: effective.mode === "effort" ? `effort:${effective.effort}`
			: effective.mode === "budget" ? "budget" : "auto";
	const badge = effective.mode === "auto" ? "Automatic"
		: effective.mode === "off" ? "Off"
			: effective.mode === "effort" ? effective.effort
				: `${effective.budget.toLocaleString("en-US")} tokens`;

	const customNumber = Number(customValue);
	const customMin = Number.isSafeInteger(budget.min) ? budget.min : 0;
	const customMax = Number.isSafeInteger(budget.max) ? budget.max : 65536;
	const customValid = customValue.trim() !== "" && Number.isSafeInteger(customNumber)
		&& customNumber >= customMin && customNumber <= customMax;

	const choose = (value) => {
		if (value === "auto") return void save({ thinkingBudget: -1, reasoningEffort: null });
		if (value === "off") return void save({ thinkingBudget: 0, reasoningEffort: null });
		if (value.startsWith("effort:")) {
			return void save({ thinkingBudget: -1, reasoningEffort: value.slice("effort:".length) });
		}
		// "budget" applies the value typed in the footer (or the current one).
		const next = customValid ? customNumber : effective.mode === "budget" ? effective.budget : (customMin > 0 ? customMin : 4096);
		setCustomValue(String(next));
		return void save({ thinkingBudget: next, reasoningEffort: null });
	};

	const customFooter = ({ close }) => (
		<form
			noValidate
			className="px-2 pb-1 pt-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (customValid) {
					setCustomValue(String(customNumber));
					void save({ thinkingBudget: customNumber, reasoningEffort: null });
					close();
				}
			}}
		>
			<label htmlFor="reasoning-budget-custom" className="flex cursor-pointer items-center gap-1.5 pb-2 text-xs">
				<FaCog /> Custom thinking-token budget
			</label>
			<div className="flex gap-1">
				<input
					id="reasoning-budget-custom"
					aria-label="Custom thinking tokens"
					type="number"
					min={customMin}
					max={customMax}
					step="256"
					value={customValue}
					onChange={(event) => setCustomValue(event.target.value)}
					className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--input)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
				/>
				<button
					type="submit"
					disabled={!customValid || saving}
					className="cursor-pointer rounded bg-[var(--accent)] px-3 py-1 text-xs text-[var(--on-accent)] disabled:cursor-not-allowed disabled:opacity-50"
				>
					Set
				</button>
			</div>
			<p className="mt-2 text-[10px] text-[var(--text-muted)]">
				{customMin.toLocaleString("en-US")}–{customMax.toLocaleString("en-US")} tokens.
				{budget.max == null ? " The loaded context is the effective ceiling." : ""}
			</p>
		</form>
	);

	return (
		<div className="w-full space-y-1.5">
			<SelectField
				aria-label="Reasoning"
				value={selected}
				onChange={(event) => choose(event.target.value)}
				disabled={disabled || !ready || saving}
				icon={<FaBrain />}
				openTop={true}
				items={items}
				dropdownFooter={budgetSupported ? customFooter : undefined}
				triggerLabel={`Reasoning: ${badge}`}
			/>
			{warnings.map((warning) => (
				<p key={warning} role="status" className="text-[10px] leading-snug text-[var(--text-muted)]">
					{warning}
				</p>
			))}
			{error && (
				<p role="alert" className="text-[10px] leading-snug text-[var(--error)]">{error}</p>
			)}
		</div>
	);
}

// Backwards-compatible alias for older imports; the control is now a single
// capability-driven reasoning selector, not a standalone budget picker.
export const ThinkingBudgetSelector = ReasoningSelector;

export function AgentSettingsPopover({
	sessionId,
	modelId,
	disabled,
	allowMidRunQuestions,
	onMidRunQuestionsChange,
	midRunQuestionsBusy,
	midRunQuestionsLocked = false,
	activeChatProvider = { type: "local" },
}) {
	const [isOpen, setIsOpen] = useState(false);
	const triggerRef = useRef(null);
	const menuRef = useRef(null);
	const [coords, setCoords] = useState({ top: 0, left: 0 });

	const handleToggle = () => {
		if (disabled) return;
		if (!isOpen && triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect();
			const ownerDialog = triggerRef.current.closest("dialog");
			if (ownerDialog) {
				const dialogRect = ownerDialog.getBoundingClientRect();
				setCoords({
					top: rect.top - dialogRect.top - 8,
					left: rect.right - dialogRect.left,
				});
			} else {
				setCoords({
					top: rect.top + window.scrollY - 8,
					left: rect.right + window.scrollX,
				});
			}
		}
		setIsOpen(!isOpen);
	};

	useEffect(() => {
		if (!isOpen) return;
		const handleClickOutside = (e) => {
			if (
				menuRef.current &&
				!menuRef.current.contains(e.target) &&
				triggerRef.current &&
				!triggerRef.current.contains(e.target)
			) {
				setIsOpen(false);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [isOpen]);

	return (
		<div className="relative shrink-0">
			{/* Main Settings Trigger Pill */}
			<button
				type="button"
				ref={triggerRef}
				disabled={disabled}
				onClick={handleToggle}
				title="Agent Run Settings"
				className={`flex min-h-8 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${
					allowMidRunQuestions || isOpen
						? "border-[var(--control-border)] bg-[var(--surface-raised)] text-[var(--text-primary)]"
						: "border-[var(--control-border)] bg-[var(--input)] text-[var(--text-muted)] hover:border-[var(--edit-border)] hover:bg-[var(--surface-hover)]"
				} disabled:cursor-not-allowed disabled:opacity-40`}
			>
				<LuSlidersHorizontal className="size-3.5 text-[var(--text-muted)]" />
				<span className="font-medium">Settings</span>
				{/* Subtle active indicator dot when mid-run questions are on */}
				{allowMidRunQuestions && <span className="size-1.5 rounded-full bg-[var(--accent)]" />}
			</button>

			{/* Popover Menu Panel */}
			{isOpen &&
				createPortal(
					<div
						ref={menuRef}
						style={{
							top: coords.top,
							left: coords.left,
							transform: "translate(-100%, -100%)",
						}}
						className="absolute z-[9999] w-72 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-3 text-xs text-[var(--text-primary)] shadow-2xl space-y-3"
					>
						<div className="font-semibold text-[var(--text-secondary)] border-b border-[var(--subtle-border)] pb-2">
							Run Settings
						</div>

						<CheckboxField
							label={
								<span className="flex items-center gap-2">
									<span>Mid-Run Questions</span>
								</span>
							}
							hint={
								midRunQuestionsLocked
									? "Always on in workspace chats — the agent needs input to proceed"
									: "Agent may pause mid-run to ask for input or decisions"
							}
							checked={midRunQuestionsLocked ? true : allowMidRunQuestions}
							disabled={midRunQuestionsBusy || midRunQuestionsLocked}
							onChange={(e) => onMidRunQuestionsChange?.(e.target.checked)}
						/>

						{/* 2. Reasoning: one capability-driven control. Automatic,
						    Off, efforts, and a numeric budget are offered only when
						    the selected model/provider supports them. */}
						<div className="border-t border-[var(--subtle-border)] pt-2.5">
							<div className="mb-1.5 flex items-center gap-2 text-[var(--text-secondary)] font-medium">
								<LuBrain className="size-3.5 text-[var(--text-muted)]" />
								<span>Reasoning</span>
							</div>
							<ReasoningSelector
								sessionId={sessionId}
								modelId={modelId}
								activeChatProvider={activeChatProvider}
								disabled={disabled}
							/>
						</div>
					</div>,
					triggerRef.current?.closest("dialog") ?? document.body,
				)}
		</div>
	);
}
