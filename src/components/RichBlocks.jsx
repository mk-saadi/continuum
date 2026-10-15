import React, { useState } from "react";
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

function Checklist({ data }) {
	const items = (data.items ?? []).slice(0, 20);
	const [done, setDone] = useState(() => items.map((it) => !!it.done));
	const count = done.filter(Boolean).length;
	const toggle = (i) => setDone((d) => d.map((v, j) => (j === i ? !v : v)));
	return (
		<div className="rich-block">
			{data.title && <div className="rich-title">{clip(data.title, 120)}</div>}
			<ul className="rich-checklist">
				{items.map((it, i) => (
					<li key={i}>
						<label>
							<input type="checkbox" checked={done[i]} onChange={() => toggle(i)} />
							<span>{clip(it.text, 200)}</span>
						</label>
					</li>
				))}
			</ul>
			<div className="rich-footer">
				<span>
					{count} of {items.length} done
				</span>
				<span className="rich-pill">{count === items.length ? "Complete" : clip(data.status ?? "In progress", 30)}</span>
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

const RENDERERS = { cards: Cards, checklist: Checklist, flow: Flow };

export function RichBlock({ kind, raw, streaming, fallback }) {
	const data = parseRichBlock(raw, streaming);
	const Renderer = RENDERERS[kind];
	if (!data || !Renderer) {
		return streaming ? <div className="rich-block rich-skeleton" /> : fallback;
	}
	return <Renderer key={raw} data={data} />;
}
