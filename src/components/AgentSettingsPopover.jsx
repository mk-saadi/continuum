import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { LuSlidersHorizontal, LuMessageSquare, LuBrain } from "react-icons/lu";
import { CheckboxField, SelectField } from "./FormControls";
import { FaBalanceScale, FaBolt, FaBrain, FaBullseye, FaCog, FaInfinity, FaMicroscope } from "react-icons/fa";

const BUDGET_PRESETS = [
	{ value: 0, label: "Off / Fast", icon: FaBolt, description: "0 tokens" },
	{ value: 1024, label: "Light", icon: FaBullseye, description: "1,024 tokens" },
	{ value: 4096, label: "Balanced", icon: FaBalanceScale, description: "4,096 tokens" },
	{ value: 8192, label: "Deep", icon: FaMicroscope, description: "8,192 tokens" },
	{ value: -1, label: "Unlimited", icon: FaInfinity, description: "Model default" },
];

export function ThinkingBudgetSelector({ sessionId, modelId, disabled }) {
	const [budget, setBudget] = useState(-1);
	const [customValue, setCustomValue] = useState("");
	const [ready, setReady] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const revision = useRef(0);

	useEffect(() => {
		let alive = true;
		const refresh = async () => {
			const request = ++revision.current;
			setReady(false);
			try {
				const result = await window.api.getEffectiveSettings(sessionId, modelId);
				if (alive && request === revision.current) {
					const next = result.effective.thinkingBudget ?? -1;
					setBudget(next);
					setCustomValue(next >= 0 ? String(next) : "");
					setError("");
					setReady(true);
				}
			} catch (cause) {
				if (alive && request === revision.current) setError(cause.message);
			}
		};
		if (modelId) void refresh();
		window.addEventListener("generation-settings-changed", refresh);
		return () => {
			alive = false;
			revision.current++;
			window.removeEventListener("generation-settings-changed", refresh);
		};
	}, [sessionId, modelId]);

	// We accept `closeMenu` so the SelectField dropdown closes when they hit 'Set'
	async function save(next, closeMenu) {
		const previous = budget;
		const request = ++revision.current;
		setBudget(next);
		setCustomValue(String(next));
		setSaving(true);
		setError("");
		try {
			if (sessionId) await window.api.saveSamplingParams(sessionId, modelId, { thinking_budget: next });
			else await window.api.saveProfileSettings(modelId, { thinkingBudget: next });

			if (request === revision.current) {
				setSaving(false);
				if (closeMenu) closeMenu();
				window.dispatchEvent(new Event("generation-settings-changed"));
			}
		} catch (cause) {
			if (request === revision.current) {
				setBudget(previous);
				setError(cause.message);
				setSaving(false);
			}
		}
	}

	const preset = BUDGET_PRESETS.find((item) => item.value === budget);
	const badge = preset ? preset.label.replace(" / Fast", "") : `${budget.toLocaleString("en-US")} t`;
	const customNumber = Number(customValue);
	const customValid =
		customValue.trim() !== "" &&
		Number.isSafeInteger(customNumber) &&
		customNumber >= 0 &&
		customNumber <= 65536;

	// Custom Form rendered inside SelectField's dropdownFooter
	const customFooter = ({ close }) => (
		<form
			noValidate
			className="px-2 pb-1 pt-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (customValid) void save(customNumber, close);
			}}
		>
			<label
				htmlFor="thinking-budget-custom"
				className="flex cursor-pointer items-center gap-1.5 pb-2 text-xs"
			>
				<FaCog /> Custom token budget
			</label>
			<div className="flex gap-1">
				<input
					id="thinking-budget-custom"
					aria-label="Custom thinking tokens"
					type="number"
					min="0"
					max="65536"
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
				0–65,536 tokens. Exact integers are accepted.
			</p>
		</form>
	);

	return (
		<div className="w-full">
			<SelectField
				aria-label={`Thinking Budget: ${badge}`}
				value={budget}
				onChange={(event) => void save(Number(event.target.value))}
				disabled={disabled || !ready || saving}
				icon={<FaBrain />}
				openTop={true}
				items={BUDGET_PRESETS.map((item) => ({
					value: item.value,
					label: item.label,
					description: item.description,
					icon: <item.icon />,
				}))}
				dropdownFooter={customFooter}
				triggerLabel={`Thinking: ${badge}`}
			/>
			{error && (
				<p
					role="alert"
					className="absolute bottom-full right-0 mb-1 w-max rounded bg-[var(--error)] px-2 py-1 text-xs text-white shadow"
				>
					{error}
				</p>
			)}
		</div>
	);
}

export function AgentSettingsPopover({
	sessionId,
	modelId,
	disabled,
	allowMidRunQuestions,
	onMidRunQuestionsChange,
	midRunQuestionsBusy,
	showEffort,
	supportedEfforts = [],
	reasoningEffort,
	onEffortChange,
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
							hint="Agent may pause mid-run to ask for input or decisions"
							checked={allowMidRunQuestions}
							disabled={midRunQuestionsBusy}
							onChange={(e) => onMidRunQuestionsChange?.(e.target.checked)}
						/>

						{/* 2. Token Thinking Budget */}
						<div className="border-t border-[var(--subtle-border)] pt-2.5">
							<div className="mb-1.5 flex items-center gap-2 text-[var(--text-secondary)] font-medium">
								<LuBrain className="size-3.5 text-[var(--text-muted)]" />
								<span>Thinking Token Budget</span>
							</div>
							<ThinkingBudgetSelector
								sessionId={sessionId}
								modelId={modelId}
								disabled={disabled}
							/>
						</div>

						{/* 3. Reasoning Effort (if supported by model) */}
						{showEffort && supportedEfforts.length > 0 && (
							<div className="border-t border-[var(--subtle-border)] pt-2.5">
								<div className="mb-1.5 flex items-center gap-2 text-[var(--text-secondary)] font-medium">
									<LuBrain className="size-3.5 text-[var(--text-muted)]" />
									<span>Reasoning Effort</span>
								</div>
								<div className="grid grid-cols-3 gap-1">
									{supportedEfforts.map((effort) => (
										<button
											key={effort}
											type="button"
											onClick={() => onEffortChange?.(effort)}
											className={`rounded-lg border px-2 py-1 text-center text-[11px] capitalize transition-colors ${
												reasoningEffort === effort
													? "border-[var(--accent)] bg-[var(--accent)]/10 font-medium text-[var(--accent)]"
													: "border-[var(--control-border)] bg-[var(--input)] text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
											}`}
										>
											{effort}
										</button>
									))}
								</div>
							</div>
						)}
					</div>,
					triggerRef.current?.closest("dialog") ?? document.body,
				)}
		</div>
	);
}
