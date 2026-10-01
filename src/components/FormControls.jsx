import React, { forwardRef, useId, useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { LuCheck, LuChevronDown } from "react-icons/lu";

const fieldFrame =
	"flex min-h-8 items-center rounded-xl border border-[var(--control-border)] bg-[var(--input)] text-[var(--text-primary)] transition-colors hover:border-[var(--edit-border)] focus-within:border-[var(--accent)] focus-within:ring-1 focus-within:ring-[var(--accent)] has-[:disabled]:opacity-50";

function FieldShell({ id, label, hint, required, children, className = "" }) {
	return (
		<div className={`min-w-0 ${className}`}>
			{label && (
				<label
					htmlFor={id}
					className="mb-1 block text-xs font-semibold text-[var(--text-primary)]"
				>
					{label}
					{required && (
						<span
							className="ml-1 text-[var(--accent)]"
							aria-hidden="true"
						>
							*
						</span>
					)}
				</label>
			)}
			{children}
			{hint && (
				<p
					id={`${id}-hint`}
					className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]"
				>
					{hint}
				</p>
			)}
		</div>
	);
}

export const TextField = forwardRef(function TextField(
	{ label, hint, id: suppliedId, className, inputClassName = "", required, ...inputProps },
	ref,
) {
	const generatedId = useId();
	const id = suppliedId || generatedId;
	return (
		<FieldShell
			id={id}
			label={label}
			hint={hint}
			required={required}
			className={className}
		>
			<div className={fieldFrame}>
				<input
					{...inputProps}
					id={id}
					ref={ref}
					required={required}
					aria-describedby={hint ? `${id}-hint` : undefined}
					className={`min-w-0 w-full bg-transparent px-3 py-1.5 text-sm outline-none placeholder:text-[var(--text-muted)] ${inputClassName}`}
				/>
			</div>
		</FieldShell>
	);
});

export const NumberField = forwardRef(function NumberField(props, ref) {
	return (
		<TextField
			{...props}
			ref={ref}
			type="number"
			inputClassName={`appearance-none tabular-nums [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${props.inputClassName || ""}`}
		/>
	);
});

export const SelectField = forwardRef(function SelectField(
	{
		label,
		hint,
		id: suppliedId,
		className,
		required,
		children,
		value,
		onChange,
		placeholder = "Select...",
		disabled,
		openTop = false,
		icon,
		items = [], // Array of { value, label, description, icon }
		dropdownFooter, // ReactNode OR Function({ close }) => ReactNode
		triggerLabel, // Override text shown on the main button
		hideChevron = false,
		...selectProps
	},
	ref,
) {
	const generatedId = useId();
	const id = suppliedId || generatedId;
	const [isOpen, setIsOpen] = useState(false);
	const [menuCoords, setMenuCoords] = useState({ top: 0, left: 0, width: 0 });

	const triggerRef = useRef(null);
	const menuRef = useRef(null);

	// Use items array if provided, fallback to standard <option> children
	const options =
		items.length > 0
			? items
			: React.Children.toArray(children)
					.filter((child) => React.isValidElement(child) && child.type === "option")
					.map((child) => ({
						value: child.props.value,
						label: child.props.children,
					}));

	const selectedOption = options.find((opt) => String(opt.value) === String(value));

	const handleOpen = () => {
		if (disabled) return;
		if (triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect();
			const ownerDialog = triggerRef.current.closest("dialog");

			let topPos;
			if (ownerDialog) {
				const dialogRect = ownerDialog.getBoundingClientRect();
				topPos = openTop ? rect.top - dialogRect.top - 6 : rect.bottom - dialogRect.top + 6;
				setMenuCoords({ top: topPos, left: rect.left - dialogRect.left, width: rect.width });
			} else {
				topPos = openTop ? rect.top + window.scrollY - 6 : rect.bottom + window.scrollY + 6;
				setMenuCoords({ top: topPos, left: rect.left + window.scrollX, width: rect.width });
			}
			setIsOpen(true);
		}
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

	useEffect(() => {
		if (isOpen && menuRef.current) {
			const firstItem = menuRef.current.querySelector('button[role="option"]');
			firstItem?.focus();
		}
	}, [isOpen]);

	return (
		<FieldShell
			id={id}
			label={label}
			hint={hint}
			required={required}
			className={className}
		>
			<div className={`${fieldFrame} relative`}>
				<select
					{...selectProps}
					ref={ref}
					value={value}
					onChange={onChange}
					required={required}
					disabled={disabled}
					className="sr-only"
					aria-hidden="true"
					tabIndex={-1}
				>
					<option
						value=""
						disabled
					>
						{placeholder}
					</option>
					{items.length > 0
						? items.map((opt) => (
								<option
									key={opt.value}
									value={opt.value}
								>
									{opt.label}
								</option>
							))
						: children}
				</select>

				<button
					type="button"
					id={id}
					ref={triggerRef}
					disabled={disabled}
					aria-haspopup="listbox"
					aria-expanded={isOpen}
					aria-describedby={hint ? `${id}-hint` : undefined}
					onClick={() => (isOpen ? setIsOpen(false) : handleOpen())}
					className="flex min-w-0 cursor-pointer w-full appearance-none items-center justify-between bg-transparent px-3 py-1 text-sm text-[var(--text-primary)] outline-none focus-visible:outline-none disabled:cursor-not-allowed"
				>
					<div className="flex items-center gap-2 truncate pr-2">
						{icon && (
							<span className="flex shrink-0 items-center text-[var(--text-muted)]">
								{icon}
							</span>
						)}
						<span
							className={
								!selectedOption && !triggerLabel ? "text-[var(--text-primary)]!" : "truncate"
							}
						>
							{triggerLabel !== undefined
								? triggerLabel
								: selectedOption
									? selectedOption.label
									: placeholder}
						</span>
					</div>
					{!hideChevron && (
						<LuChevronDown
							size={16}
							aria-hidden="true"
							className={`shrink-0 text-[var(--text-primary)] transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
						/>
					)}
				</button>

				{isOpen &&
					createPortal(
						<div
							ref={menuRef}
							role="listbox"
							aria-label={label || "Select options"}
							style={{
								left: menuCoords.left,
								top: menuCoords.top,
								width: menuCoords.width,
								...(openTop ? { transform: "translateY(-100%)" } : {}),
							}}
							className="absolute z-[9999] min-w-[220px] max-h-72 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-1 text-[var(--text-primary)] shadow-xl"
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									setIsOpen(false);
									triggerRef.current?.focus();
								}
								if (event.key === "Tab") setIsOpen(false);
								if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
									event.preventDefault();
									const items = [
										...event.currentTarget.querySelectorAll('button[role="option"]'),
									];
									const index = items.indexOf(document.activeElement);
									items[
										event.key === "Home"
											? 0
											: event.key === "End"
												? items.length - 1
												: (index +
														(event.key === "ArrowDown" ? 1 : -1) +
														items.length) %
													items.length
									]?.focus();
								}
							}}
						>
							{options.map((opt) => (
								<button
									key={opt.value}
									type="button"
									role="option"
									aria-selected={String(opt.value) === String(value)}
									className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 my-0.5 text-left text-sm transition-colors hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)] focus-visible:outline-none ${
										String(opt.value) === String(value)
											? "bg-[var(--surface-hover)] font-medium"
											: ""
									}`}
									onClick={() => {
										onChange?.({ target: { value: opt.value } });
										setIsOpen(false);
										triggerRef.current?.focus();
									}}
								>
									<div className="flex items-center gap-2 truncate pr-4">
										{opt.icon && (
											<span
												className={`shrink-0 ${String(opt.value) === String(value) ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
											>
												{opt.icon}
											</span>
										)}
										<span className="truncate">{opt.label}</span>
									</div>
									{opt.description ? (
										<span
											className={`shrink-0 text-xs ${String(opt.value) === String(value) ? "text-[var(--accent)] font-medium" : "text-[var(--text-muted)]"}`}
										>
											{opt.description}
										</span>
									) : (
										String(opt.value) === String(value) && (
											<LuCheck
												size={14}
												className="shrink-0 text-[var(--accent)]"
											/>
										)
									)}
								</button>
							))}

							{/* Custom Footer Form Injection */}
							{dropdownFooter && (
								<div className="mt-1 border-t border-[var(--border)] pt-1">
									{typeof dropdownFooter === "function"
										? dropdownFooter({
												close: () => {
													setIsOpen(false);
													triggerRef.current?.focus();
												},
											})
										: dropdownFooter}
								</div>
							)}
						</div>,
						triggerRef.current?.closest("dialog") ?? document.body,
					)}
			</div>
		</FieldShell>
	);
});

export const CheckboxField = forwardRef(function CheckboxField(
	{ label, hint, id: suppliedId, className = "", disabled, ...inputProps },
	ref,
) {
	const generatedId = useId();
	const id = suppliedId || generatedId;
	return (
		<div className={`min-w-0 ${className}`}>
			<label
				htmlFor={id}
				className={`group flex w-full cursor-pointer items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 transition-colors hover:bg-[var(--surface-hover)] ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
			>
				<input
					{...inputProps}
					id={id}
					ref={ref}
					type="checkbox"
					disabled={disabled}
					aria-describedby={hint ? `${id}-hint` : undefined}
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
						<span
							id={`${id}-hint`}
							className="mt-1 block text-[11px] leading-relaxed text-[var(--text-muted)]"
						>
							{hint}
						</span>
					)}
				</span>
			</label>
		</div>
	);
});

export const TextAreaField = forwardRef(function TextAreaField(
	{ label, hint, id: suppliedId, className, inputClassName = "", required, ...inputProps },
	ref,
) {
	const generatedId = useId();
	const id = suppliedId || generatedId;
	return (
		<FieldShell
			id={id}
			label={label}
			hint={hint}
			required={required}
			className={className}
		>
			<div className="flex rounded-xl border border-[var(--control-border)] bg-[var(--input)] text-[var(--text-primary)] transition-colors hover:border-[var(--edit-border)] focus-within:border-[var(--accent)] focus-within:ring-1 focus-within:ring-[var(--accent)] has-[:disabled]:opacity-50">
				<textarea
					{...inputProps}
					id={id}
					ref={ref}
					required={required}
					aria-describedby={hint ? `${id}-hint` : undefined}
					className={`min-w-0 w-full bg-transparent px-3 py-2 text-sm outline-none placeholder:text-[var(--text-muted)] ${inputClassName}`}
				/>
			</div>
		</FieldShell>
	);
});

export const SliderField = forwardRef(function SliderField(
	{ label, valueLabel, hint, id: suppliedId, className, inputClassName = "", required, ...inputProps },
	ref,
) {
	const generatedId = useId();
	const id = suppliedId || generatedId;
	const [isActive, setIsActive] = useState(false);

	const labelContent = (
		<span className="flex items-center justify-between gap-2">
			<span>{label}</span>
			{valueLabel !== undefined && <span className="font-normal tabular-nums">{valueLabel}</span>}
		</span>
	);

	const min = Number(inputProps.min) || 0;
	const max = Number(inputProps.max) || 100;
	const value = Number(inputProps.value) || 0;
	const percentage = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

	return (
		<FieldShell
			id={id}
			label={labelContent}
			hint={hint}
			required={required}
			className={className}
		>
			<div className={`relative flex h-11 items-center ${inputProps.disabled ? "opacity-40" : ""}`}>
				{/* Visual track */}
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 h-1.5 rounded-full overflow-hidden transition-[height] duration-200"
					style={{
						background: `linear-gradient(to right, var(--accent) ${percentage}%, var(--active-chat) ${percentage}%)`,
					}}
				/>

				{/* Visual thumb — scales up when pressed or hovered */}
				<div
					aria-hidden="true"
					className={`pointer-events-none absolute rounded-full bg-[var(--accent)] shadow-sm -translate-x-1/2 transition-all duration-200 ease-out
                    ${isActive ? "size-5 shadow-md" : "size-3"}`}
					style={{ left: `${percentage}%` }}
				/>

				{/* Real input */}
				<input
					{...inputProps}
					id={id}
					ref={ref}
					type="range"
					required={required}
					aria-describedby={hint ? `${id}-hint` : undefined}
					onPointerDown={(e) => {
						setIsActive(true);
						inputProps.onPointerDown?.(e);
					}}
					onPointerUp={(e) => {
						setIsActive(false);
						inputProps.onPointerUp?.(e);
					}}
					onPointerLeave={(e) => {
						setIsActive(false);
						inputProps.onPointerLeave?.(e);
					}}
					onKeyDown={(e) => {
						setIsActive(true);
						inputProps.onKeyDown?.(e);
					}}
					onKeyUp={(e) => {
						setIsActive(false);
						inputProps.onKeyUp?.(e);
					}}
					onBlur={(e) => {
						setIsActive(false);
						inputProps.onBlur?.(e);
					}}
					className={`absolute inset-0 w-full h-full m-0 appearance-none bg-transparent cursor-pointer opacity-0 disabled:cursor-not-allowed
                    [&::-webkit-slider-thumb]:appearance-none
                    [&::-webkit-slider-thumb]:size-4
                    [&::-webkit-slider-thumb]:h-11
                    [&::-webkit-slider-thumb]:w-4
                    [&::-moz-range-thumb]:appearance-none
                    [&::-moz-range-thumb]:size-4
                    [&::-moz-range-thumb]:border-none
                    focus-visible:opacity-100 focus-visible:relative focus-visible:z-10
                    focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-[var(--accent)]
                    focus-visible:[&::-moz-range-thumb]:ring-2 focus-visible:[&::-moz-range-thumb]:ring-[var(--accent)]
                    disabled:opacity-0
                    ${inputClassName}`}
				/>
			</div>
		</FieldShell>
	);
});
