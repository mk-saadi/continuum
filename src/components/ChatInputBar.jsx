import React, {
	forwardRef,
	memo,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { GrAttachment } from "react-icons/gr";
import { IoSend } from "react-icons/io5";
import {
	FaStop,
	FaBolt,
	FaBullseye,
	FaBalanceScale,
	FaMicroscope,
	FaInfinity,
	FaShieldAlt,
	FaPencilAlt,
	FaQuestionCircle,
	FaBrain,
	FaCog,
} from "react-icons/fa";
import { PiShieldWarningBold } from "react-icons/pi";
import useSessionDraft from "../hooks/useSessionDraft";
import { SelectField } from "./FormControls";

const BUDGET_PRESETS = [
	{ value: 0, label: "Off / Fast", icon: FaBolt, description: "0 tokens" },
	{ value: 1024, label: "Light", icon: FaBullseye, description: "1,024 tokens" },
	{ value: 4096, label: "Balanced", icon: FaBalanceScale, description: "4,096 tokens" },
	{ value: 8192, label: "Deep", icon: FaMicroscope, description: "8,192 tokens" },
	{ value: -1, label: "Unlimited", icon: FaInfinity, description: "Model default" },
];

const ChatInputBar = memo(
	forwardRef(function ChatInputBar(
		{
			sessionId,
			onSubmit,
			onQueue,
			onStop,
			onAttach,
			canSubmit,
			hasAttachments,
			streaming,
			loading,
			attachDisabled,
			sendTitle,
			permissionMode = "ask_approval",
			onPermissionModeChange,
			modelId,
			supportedEfforts = [],
			reasoningEffort,
			onEffortChange,
			showEffort,
		},
		ref,
	) {
		// This hook owns the local text and the cancellable 1-second storage debounce.
		const { input: draftText, updateDraft, clearSubmitted } = useSessionDraft(sessionId);
		const textarea = useRef(null);

		useImperativeHandle(ref, () => ({ clearSubmitted }), [clearSubmitted]);

		useLayoutEffect(() => {
			const element = textarea.current;
			element.style.height = "auto";
			element.style.height = `${element.scrollHeight}px`;
		}, [draftText]);

		const ready = canSubmit && !streaming && !loading && (draftText.trim() || hasAttachments);
		const submit = () => {
			if (ready) onSubmit(draftText);
		};

		return (
			<>
				<textarea
					ref={textarea}
					aria-label="Message"
					className="max-h-[200px] sm:max-h-[350px] min-h-[38px] w-full resize-none overflow-y-auto rounded-md py-[9px] text-sm leading-normal text-[var(--text-primary)] transition-colors duration-300 placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					value={draftText}
					onChange={(event) => updateDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229)
							return;
						if ((event.ctrlKey || event.metaKey) && event.shiftKey && onQueue) {
							event.preventDefault();
							if (!event.repeat && draftText.trim()) {
								onQueue(draftText);
								clearSubmitted(draftText, sessionId);
							}
						} else if (!event.shiftKey) {
							event.preventDefault();
							if (!event.repeat) submit();
						}
					}}
					placeholder="Type a message..."
					rows={1}
				/>

				<div className="flex items-center justify-between gap-2">
					<button
						type="button"
						aria-label="Attach files"
						title="Attach images, PDF, TXT, Markdown, or CSV"
						disabled={streaming || loading || attachDisabled}
						onClick={onAttach}
						className="flex shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
					>
						<GrAttachment />
					</button>

					<PermissionSelector
						value={permissionMode}
						onChange={onPermissionModeChange}
						disabled={streaming || loading}
					/>

					<ThinkingBudgetSelector
						sessionId={sessionId}
						modelId={modelId}
						disabled={!modelId || streaming || loading}
					/>

					{showEffort && supportedEfforts.length > 0 && (
						<label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-secondary)]">
							<FaBrain className="shrink-0" />
							<span>Effort:</span>
							<select
								aria-label="Reasoning effort"
								value={reasoningEffort}
								disabled={streaming || loading}
								onChange={(event) => onEffortChange(event.target.value)}
								className="max-w-32 cursor-pointer rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[var(--text-primary)]"
							>
								{supportedEfforts.map((effort) => (
									<option
										key={effort}
										value={effort}
									>
										{effort.charAt(0).toUpperCase() + effort.slice(1)}
									</option>
								))}
							</select>
						</label>
					)}

					<button
						type="button"
						title={streaming ? "Stop" : sendTitle}
						aria-label={streaming ? "Stop" : "Send"}
						onClick={streaming ? onStop : submit}
						disabled={!streaming && !ready}
						className="flex size-[28px] shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-[var(--accent)] text-[var(--on-accent)] transition-all duration-300 hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
					>
						{streaming ? <FaStop /> : <IoSend />}
					</button>
				</div>
			</>
		);
	}),
);

// Make sure to import SelectField at the top of your file
// import { SelectField } from './path-to-your-SelectField';

function PermissionSelector({ value = "ask_approval", onChange, disabled }) {
	const getIcon = (val) => {
		switch (val) {
			case "read_only":
				return <FaShieldAlt />;
			case "workspace_write":
				return <FaPencilAlt />;
			case "ask_approval":
				return <FaQuestionCircle />;
			case "full_access":
				return <PiShieldWarningBold />;
			default:
				return <FaQuestionCircle />;
		}
	};

	return (
		<div className="mr-auto w-full max-w-[200px]">
			<SelectField
				aria-label="Tool permission mode"
				title="Tool permission mode"
				value={value}
				onChange={(event) => onChange?.(event.target.value)}
				disabled={disabled}
				icon={getIcon(value)}
				openTop={true}
			>
				<option value="read_only">Read Only</option>
				<option value="workspace_write">Workspace Write</option>
				<option value="ask_approval">Ask for Approval</option>
				<option value="full_access">Full Access</option>
			</SelectField>
		</div>
	);
}

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
		<div className="w-full max-w-[190px]">
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

export default ChatInputBar;
