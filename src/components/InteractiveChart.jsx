import React, { useMemo, useState } from 'react';
import {
	Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
	Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

const COLORS = ['#3b82f6', '#f97316', '#22c55e', '#a855f7', '#ec4899', '#14b8a6', '#eab308', '#ef4444'];
const CHART_TYPES = new Set(['bar', 'line', 'area', 'pie']);

function prepareChart(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input) || !CHART_TYPES.has(input.type)) {
		throw new Error('Chart type must be bar, line, area, or pie.');
	}
	if (!Array.isArray(input.data) || !input.data.length || input.data.length > 200 ||
		!Array.isArray(input.series) || !input.series.length || input.series.length > 8) {
		throw new Error('Charts need 1–200 data rows and 1–8 series.');
	}
	const xAxisKey = input.xAxisKey;
	if (typeof xAxisKey !== 'string' || !xAxisKey || xAxisKey.length > 100) {
		throw new Error('Charts need a valid xAxisKey.');
	}
	const keys = new Set([xAxisKey]);
	const series = input.series.map((item, index) => {
		if (!item || typeof item.key !== 'string' || !item.key || item.key.length > 100) {
			throw new Error('Each chart series needs a valid key.');
		}
		if (keys.has(item.key) || ['__proto__', 'prototype', 'constructor'].includes(item.key)) {
			throw new Error('Chart series keys must be unique and distinct from xAxisKey.');
		}
		keys.add(item.key);
		return {
			key: item.key,
			label: typeof item.label === 'string' ? item.label.slice(0, 100) : item.key,
			color: typeof item.color === 'string' && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(item.color)
				? item.color : COLORS[index % COLORS.length],
		};
	});
	const rows = input.data.map(row => {
		if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid chart data row.');
		const result = { [xAxisKey]: String(row[xAxisKey] ?? '').slice(0, 100) };
		for (const item of series) {
			const value = row[item.key];
			result[item.key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
		}
		return result;
	});
	return {
		type: input.type,
		title: typeof input.title === 'string' ? input.title.slice(0, 160) : '',
		xAxisKey, series, rows,
	};
}

function SeriesLegend({ items, hidden, toggle }) {
	return <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 pt-2 text-xs">
		{items.map(item => <button key={item.key} type="button" onClick={() => toggle(item.key)}
			aria-pressed={!hidden.has(item.key)} aria-label={`${hidden.has(item.key) ? 'Show' : 'Hide'} ${item.label}`}
			className={`inline-flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] ${hidden.has(item.key) ? 'opacity-45' : ''}`}>
			<span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
			{item.label}
		</button>)}
	</div>;
}

export default function InteractiveChart({ data }) {
	const [hidden, setHidden] = useState(() => new Set());
	const prepared = useMemo(() => {
		try { return { chart: prepareChart(data) }; }
		catch (error) { return { error: error.message }; }
	}, [data]);
	if (prepared.error) return <div role="alert" className="my-3 rounded-lg border border-[var(--code-border)] bg-[var(--surface)] p-3 text-sm text-[var(--text-muted)]">Unable to render chart: invalid JSON schema</div>;

	const { type, title, xAxisKey, series, rows } = prepared.chart;
	const toggle = key => setHidden(current => {
		const next = new Set(current);
		if (next.has(key)) next.delete(key); else next.add(key);
		return next;
	});
	const legend = items => <SeriesLegend items={items} hidden={hidden} toggle={toggle} />;
	const tooltip = <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)' }}
		labelStyle={{ color: 'var(--text-primary)' }} itemStyle={{ color: 'var(--text-primary)' }} />;
	const axis = { tick: { fill: 'var(--text-muted)', fontSize: 11 }, axisLine: { stroke: 'var(--border)' }, tickLine: false };
	const grid = <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />;
	const pieKey = series[0]?.key;
	const pieItems = rows.map((row, index) => ({ key: String(index), label: row[xAxisKey] || `Slice ${index + 1}`, color: COLORS[index % COLORS.length] }));
	const pieRows = rows.filter((_, index) => !hidden.has(String(index)));
	const common = { data: rows, margin: { top: 8, right: 16, bottom: 4, left: 0 } };

	let chart;
	if (type === 'pie') {
		chart = <PieChart>
			<Pie data={pieRows} dataKey={pieKey} nameKey={xAxisKey} cx="50%" cy="45%" outerRadius="70%"
				isAnimationActive animationDuration={300}>
				{pieRows.map(row => <Cell key={`${row[xAxisKey]}-${rows.indexOf(row)}`} fill={COLORS[rows.indexOf(row) % COLORS.length]} />)}
			</Pie>
			{tooltip}<Legend content={() => legend(pieItems)} />
		</PieChart>;
	} else {
		const children = <>
			{grid}<XAxis dataKey={xAxisKey} {...axis} /><YAxis {...axis} />{tooltip}
			<Legend content={() => legend(series)} />
			{series.map(item => type === 'bar'
				? <Bar key={item.key} dataKey={item.key} name={item.label} fill={item.color} hide={hidden.has(item.key)} isAnimationActive animationDuration={300} />
				: type === 'line'
					? <Line key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} hide={hidden.has(item.key)} isAnimationActive animationDuration={300} />
					: <Area key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.color} fill={item.color} fillOpacity={0.25} strokeWidth={2} hide={hidden.has(item.key)} isAnimationActive animationDuration={300} />)}
		</>;
		chart = type === 'bar' ? <BarChart {...common}>{children}</BarChart>
			: type === 'line' ? <LineChart {...common}>{children}</LineChart>
				: <AreaChart {...common}>{children}</AreaChart>;
	}

	return <figure className="my-3 min-w-0 rounded-lg border border-[var(--code-border)] bg-[var(--surface)] p-3 text-[var(--text-primary)]">
		{title && <figcaption className="mb-2 text-center text-sm font-medium">{title}</figcaption>}
		<div role="group" aria-label={title || `${type} chart`} className="h-72 min-w-0 w-full">
			<ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
		</div>
	</figure>;
}
