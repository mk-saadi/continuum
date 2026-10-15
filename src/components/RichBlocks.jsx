import React from "react";
import { jsonrepair } from "jsonrepair";

export const RICH_HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const clip = (s, n = 400) => String(s ?? "").slice(0, n);

export function parseRichBlock(raw, streaming = false) {
	try {
		return JSON.parse(raw);
	} catch {
		if (streaming) return null;
		try {
			return JSON.parse(jsonrepair(String(raw ?? "")));
		} catch {
			return null;
		}
	}
}

function Swatches({ colors }) {
	const safe = (Array.isArray(colors) ? colors : []).filter((c) => RICH_HEX.test(c)).slice(0, 4);
	if (!safe.length) return null;
	return (
		<div className="rich-swatches" aria-hidden="true">
			{safe.map((c, i) => (
				<span key={i} style={{ backgroundColor: c }} />
			))}
		</div>
	);
}

function Cards({ data }) {
	const items = (data.items ?? []).slice(0, 8);
	return (
		<div className="rich-block">
			{data.title && <div className="rich-title">{clip(data.title, 120)}</div>}
			<div className="rich-cards" data-cols={data.columns === 1 ? 1 : 2}>
				{items.map((item, i) => (
					<div className="rich-card" key={i}>
						<Swatches colors={item.swatches} />
						<div className="rich-card-main">
							<div className="rich-card-title">{clip(item.title, 100)}</div>
							{item.badge && <span className="rich-badge">{clip(item.badge, 40)}</span>}
							{item.body && <p className="rich-card-body">{clip(item.body)}</p>}
							{item.note && <p className="rich-card-note">{clip(item.note, 200)}</p>}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function Flow({ data }) {
	const steps = (data.steps ?? []).slice(0, 8);
	return (
		<div className="rich-block">
			{data.title && <div className="rich-title">{clip(data.title, 120)}</div>}
			<div className="rich-flow">
				{steps.map((s, i) => (
					<div key={i}>
						<div className="rich-card">
							<div className="rich-card-main">
								<div className="rich-card-title">{clip(s.title, 100)}</div>
								{s.body && <p className="rich-card-body">{clip(s.body, 240)}</p>}
							</div>
						</div>
						{i < steps.length - 1 && (
							<div className="rich-arrow" aria-hidden="true">
								↓
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

const RENDERERS = { cards: Cards, flow: Flow };

// Models improvise shapes (taught {"items":[...]} but emit [...] or plain
// strings). Normalize liberally; unshaped or empty payloads fall back to a
// code block instead of rendering empty chrome.
const LABEL_KEYS = ["title", "text", "label", "task", "name", "content", "body"];

function pickLabel(entry, textKey) {
	if (typeof entry === "string") return entry;
	const it = entry ?? {};
	for (const key of [textKey, ...LABEL_KEYS]) {
		const value = it[key];
		if (typeof value === "string" && value.trim()) return value;
		if (typeof value === "number") return String(value);
	}
	return "";
}

function normalizeData(kind, parsed) {
	const key = kind === "flow" ? "steps" : "items";
	const list = Array.isArray(parsed) ? parsed : parsed?.[key];
	if (!Array.isArray(list) || !list.length) return null;
	const shape = (entry, textKey) =>
		typeof entry === "string" ? { [textKey]: entry } : { ...(entry ?? {}), [textKey]: pickLabel(entry, textKey) };
	if (kind === "flow") return { title: parsed?.title, steps: list.map((s) => shape(s, "title")) };
	return { ...parsed, [key]: list.map((it) => shape(it, "title")) };
}

export function RichBlock({ kind, raw, streaming, fallback }) {
	const parsed = parseRichBlock(raw, streaming);
	const Renderer = RENDERERS[kind];
	const data = parsed && Renderer ? normalizeData(kind, parsed) : null;
	if (!data) {
		return streaming ? <div className="rich-block rich-skeleton" /> : fallback;
	}
	return <Renderer key={raw} data={data} />;
}
