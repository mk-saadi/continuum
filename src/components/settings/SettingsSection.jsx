import React, { useId } from "react";
import { LuCheck } from "react-icons/lu";

// Shared primitives for every settings panel. They encode the card recipe from
// docs/right-sidebar-design-language-report.md so all ten tabs read as one
// surface: one hairline border, --surface fill, 12px padding, a soft theme
// shadow, 12px semibold titles and 11px muted body copy.

export const settingsCard =
	"rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[0_2px_4px_var(--window-shadow)]";

// Native inputs/selects/textarea share the same frame as FormControls so a
// hand-written field still matches a TextField/SelectField sitting next to it.
export const settingsField =
	"min-h-8 w-full rounded-xl border border-[var(--control-border)] bg-[var(--input)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none transition-colors hover:border-[var(--edit-border)] hover:bg-[var(--surface-hover)] focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

export const settingsLabel = "mb-1 block text-xs font-semibold text-[var(--text-primary)]";

const buttonBase =
	"inline-flex cursor-pointer items-center justify-center gap-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";

const buttonVariants = {
	primary:
		"rounded-xl bg-[var(--accent)] px-3 py-2 font-semibold text-[var(--on-accent)] hover:bg-[var(--accent-hover)]",
	secondary:
		"rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 font-medium transition-colors hover:bg-[var(--surface-hover)]",
	ghost:
		"rounded-lg px-2.5 py-1.5 font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
};

export function SettingsCard({
	as: Element = "section",
	icon: Icon,
	title,
	description,
	descriptionLive = false,
	action,
	children,
	className = "",
	...rest
}) {
	const headingId = useId();
	const hasHeader = Boolean(title || description || action);
	return (
		<Element
			aria-labelledby={title ? headingId : undefined}
			className={`${settingsCard} ${className}`}
			{...rest}
		>
			{hasHeader && (
				<div className={`flex items-start justify-between gap-3 ${children ? "mb-3" : ""}`}>
					<div className="min-w-0">
						{title && (
							<div className="flex items-center gap-2">
								{Icon && (
									<Icon
										size={16}
										aria-hidden="true"
										className="shrink-0 text-[var(--accent)]"
									/>
								)}
								<h3
									id={headingId}
									className="text-xs font-semibold text-[var(--text-primary)]"
								>
									{title}
								</h3>
							</div>
						)}
						{description && (
							<p
								aria-live={descriptionLive ? "polite" : undefined}
								className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]"
							>
								{description}
							</p>
						)}
					</div>
					{action && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{action}</div>}
				</div>
			)}
			{children}
		</Element>
	);
}

export function SettingsButton({ variant = "secondary", className = "", type = "button", ...props }) {
	return (
		<button
			type={type}
			className={`${buttonBase} ${buttonVariants[variant] || buttonVariants.secondary} ${className}`}
			{...props}
		/>
	);
}

export function SettingsIconButton({ label, icon: Icon, size = 16, className = "", ...props }) {
	return (
		<button
			type="button"
			aria-label={label}
			className={`flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] active:translate-y-0.5 focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
			{...props}
		>
			{Icon ? <Icon size={size} aria-hidden="true" /> : null}
		</button>
	);
}

export function SettingsHint({ children, className = "" }) {
	if (!children) return null;
	return (
		<p className={`mt-2 text-[11px] leading-relaxed text-[var(--text-muted)] ${className}`}>
			{children}
		</p>
	);
}

export function SettingsMessage({ tone = "error", children, className = "" }) {
	if (!children) return null;
	const toneClass =
		tone === "error"
			? "font-medium text-[var(--error)]"
			: tone === "success"
				? "text-[var(--accent)]"
				: "text-[var(--text-secondary)]";
	return (
		<p
			role={tone === "error" ? "alert" : "status"}
			className={`mt-2 text-[11px] leading-relaxed ${toneClass} ${className}`}
		>
			{children}
		</p>
	);
}

export function SettingsEmpty({ children, className = "" }) {
	return (
		<p
			className={`rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-center text-[11px] leading-relaxed text-[var(--text-muted)] ${className}`}
		>
			{children}
		</p>
	);
}

// A compact checkbox row for use inside a card. CheckboxField is its
// standalone sibling: this one has no card frame of its own.
export function SettingsCheckRow({
	label,
	hint,
	id: suppliedId,
	disabled,
	className = "",
	...inputProps
}) {
	const generatedId = useId();
	const id = suppliedId || generatedId;
	return (
		<label
			htmlFor={id}
			className={`group flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--surface-hover)] ${
				disabled ? "cursor-not-allowed opacity-50" : ""
			} ${className}`}
		>
			<input
				{...inputProps}
				id={id}
				type="checkbox"
				disabled={disabled}
				className="peer sr-only"
			/>
			<span
				aria-hidden="true"
				className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-[5px] border border-[var(--control-border)] bg-[var(--input)] text-transparent transition-colors peer-checked:border-[var(--accent)] peer-checked:bg-[var(--accent)] peer-checked:text-[var(--on-accent)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--accent)]"
			>
				<LuCheck
					size={12}
					strokeWidth={3}
				/>
			</span>
			<span className="min-w-0">
				<span className="block text-xs font-medium text-[var(--text-primary)]">{label}</span>
				{hint && (
					<span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--text-muted)]">
						{hint}
					</span>
				)}
			</span>
		</label>
	);
}

// A status dot plus label, matching the sidebar's status vocabulary.
export function SettingsStatus({ active, pulse = false, children, className = "" }) {
	return (
		<span className={`inline-flex min-w-0 items-center gap-2 text-[11px] ${className}`}>
			<span
				aria-hidden="true"
				className={`size-2 shrink-0 rounded-full ${
					active ? "bg-[var(--accent)]" : "bg-[var(--text-muted)]"
				} ${active && pulse ? "animate-pulse" : ""}`}
			/>
			<span className="min-w-0 truncate">{children}</span>
		</span>
	);
}
