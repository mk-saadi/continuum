import React, { useMemo, useState } from "react";
import { costValue, coverageLabel, savingsValue, tokenValue } from "./usageDashboardFormat.mjs";
import { TextField } from "../../FormControls";
import Tooltip from "../../Tooltip";

const COLUMNS = [
	{ key: "model", label: "Model", sortable: true },
	{ key: "provider", label: "Provider", sortable: true },
	{ key: "inputTokens", label: "Input", sortable: true, numeric: true },
	{ key: "cachedInputTokens", label: "Cached", sortable: true, numeric: true },
	{ key: "outputTokens", label: "Output", sortable: true, numeric: true },
	{ key: "totalTokens", label: "Total tokens", sortable: true, numeric: true },
	{ key: "estimatedSpend", label: "Estimated", sortable: true, numeric: true },
	{ key: "providerReportedSpend", label: "Reported", sortable: true, numeric: true },
	{ key: "cacheSavings", label: "Cache savings", sortable: true, numeric: true },
	{ key: "costCoverage", label: "Coverage", sortable: false },
];

function sortValue(row, key) {
	if (key === "model") return row.modelLabel ?? row.modelId ?? "";
	if (key === "provider") return row.providerLabel ?? "";
	if (key === "costCoverage") return row.costCoverage ?? "";
	return typeof row[key] === "number" ? row[key] : -Infinity;
}

export default function ModelSpendingTable({ models = [], selectedKey = null, onSelect }) {
	const [search, setSearch] = useState("");
	const [sort, setSort] = useState({ key: "estimatedSpend", direction: "desc" });
	const filtered = useMemo(() => {
		const query = search.trim().toLowerCase();
		return models.filter(
			(row) =>
				!query ||
				(row.modelId ?? "").toLowerCase().includes(query) ||
				(row.modelLabel ?? "").toLowerCase().includes(query) ||
				(row.providerLabel ?? "").toLowerCase().includes(query) ||
				(row.providerFamilyLabel ?? "").toLowerCase().includes(query),
		);
	}, [models, search]);

	const sorted = useMemo(() => {
		const direction = sort.direction === "asc" ? 1 : -1;

		return [...filtered].sort((left, right) => {
			const a = sortValue(left, sort.key);
			const b = sortValue(right, sort.key);
			if (typeof a === "string" || typeof b === "string") {
				const text = String(a).localeCompare(String(b));
				if (text) return text * direction;
			} else if (a !== b) return (a - b) * direction;
			return (left.modelId ?? "").localeCompare(right.modelId ?? "");
		});
	}, [filtered, sort]);

	const changeSort = (key) => {
		setSort((current) =>
			current.key === key
				? { key, direction: current.direction === "asc" ? "desc" : "asc" }
				: { key, direction: key === "model" || key === "provider" ? "asc" : "desc" },
		);
	};

	return (
		<section
			className="aero-panel p-3"
			aria-labelledby="usage-model-table-title"
		>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h3
						id="usage-model-table-title"
						className="text-xs font-semibold"
					>
						Spending by cloud model
					</h3>
					<p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
						Provider identity is part of the billing identity. Select a row for rates, tokens, and
						limitations.
					</p>
				</div>
				<TextField
					type="search"
					aria-label="Find model"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					placeholder="Model or provider"
					className="w-44"
				/>
			</div>
			{models.length === 0 ? (
				<p className="mt-3 aero-empty aero-fill p-6 text-center text-[11px] text-[var(--text-muted)]">
					No cloud model usage recorded for this selection.
				</p>
			) : sorted.length === 0 ? (
				<p className="mt-3 aero-empty aero-fill p-6 text-center text-[11px] text-[var(--text-muted)]">
					No model matches “{search}”.
				</p>
			) : (
				<div className="aero-flat mt-3 overflow-x-auto p-2">
					<table className="w-full min-w-[1020px]! text-left text-xs">
						<thead>
							<tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
								{COLUMNS.map((column) => (
									<th
										key={column.key}
										scope="col"
										aria-sort={
											sort.key === column.key
												? sort.direction === "asc"
													? "ascending"
													: "descending"
												: undefined
										}
										className={`py-2 pr-3 font-medium ${column.numeric ? "text-right" : ""}`}
									>
										{column.sortable ? (
											<button
												type="button"
												className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]"
												onClick={() => changeSort(column.key)}
											>
												{column.label}
												<span
													aria-hidden="true"
													className="text-[9px]"
												>
													{sort.key === column.key
														? sort.direction === "asc"
															? "▲"
															: "▼"
														: "↕"}
												</span>
											</button>
										) : (
											column.label
										)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{sorted.map((row) => {
								const local = row.providerFamily === "local";
								const selected = row.key === selectedKey;
								return (
									<tr
										key={row.key}
										tabIndex={0}
										aria-selected={selected}
										onClick={() => onSelect?.(row)}
										onKeyDown={(event) => {
											if (event.key === "Enter" || event.key === " ") {
												event.preventDefault();
												onSelect?.(row);
											}
										}}
										className={`cursor-pointer border-b border-[var(--border)]/60 outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)] ${selected ? "bg-[var(--active-chat)]" : ""}`}
									>
										<td className="max-w-56 truncate py-2 p-3 font-medium">
											<Tooltip
												content={row.modelLabel ?? row.modelId ?? "Unknown model"}
											>
												<button
													type="button"
													className="text-left hover:underline cursor-pointer max-w-[10rem] truncate"
													onClick={(event) => {
														event.stopPropagation();
														onSelect?.(row);
													}}
												>
													{row.modelLabel ?? row.modelId ?? "Unknown model"}
												</button>
											</Tooltip>
										</td>
										<td className="py-2 pr-3">
											<span className="block">{row.providerLabel}</span>
											<span className="text-[10px] text-[var(--text-muted)]">
												{row.providerFamilyLabel}
											</span>
										</td>
										<td className="py-2 pr-3 text-right tabular-nums">
											{tokenValue(row.inputTokens, row.inputCoverage, { local })}
										</td>
										<td className="py-2 pr-3 text-right tabular-nums">
											{tokenValue(row.cachedInputTokens, row.cacheReadCoverage, {
												local,
											})}
										</td>
										<td className="py-2 pr-3 text-right tabular-nums">
											{tokenValue(row.outputTokens, row.outputCoverage, { local })}
										</td>
										<td className="py-2 pr-3 text-right tabular-nums">
											{tokenValue(row.totalTokens, row.totalTokensCoverage, { local })}
										</td>
										<td className="py-2 pr-3 text-right tabular-nums">
											{costValue(row.estimatedSpend, row.costCoverage, { local })}
										</td>
										<td className="py-2 pr-3 text-right tabular-nums">
											{costValue(
												row.providerReportedSpend,
												row.providerReportedCoverage,
												{ local },
											)}
										</td>
										<td className="py-2 pr-3 text-right tabular-nums">
											{savingsValue(row.cacheSavings, row.savingsCoverage, { local })}
										</td>
										<td
											className={`py-2 pr-3 ${row.costCoverage === "partially_measured" ? "text-[var(--text-secondary)]" : ""}`}
										>
											{coverageLabel(row.costCoverage)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			<p className="mt-3 text-[11px] text-[var(--text-muted)]">
				“Estimated” is rate-based spending. “Reported” is an authoritative provider charge and is kept
				separate. Local model usage is available in the Token usage tab.
			</p>
		</section>
	);
}
