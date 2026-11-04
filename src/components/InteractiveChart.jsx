import React, { useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Legend,
	Line,
	LineChart,
	Pie,
	PieChart,
	PolarAngleAxis,
	PolarGrid,
	PolarRadiusAxis,
	Radar,
	RadarChart,
	ResponsiveContainer,
	Scatter,
	ScatterChart,
	Tooltip,
	XAxis,
	YAxis,
	useYAxisScale,
} from "recharts";

const PASTEL_COLORS = ["#A8D8EA", "#F7C6D0", "#C9E4C5", "#FDE2B3", "#D4C5F0", "#B8E0D8"];
const COLORS = PASTEL_COLORS;
const CHART_TYPES = new Set(["bar", "line", "area", "pie", "scatter", "radar", "candlestick"]);

const CANDLE_UP = "#22c55e";
const CANDLE_DOWN = "#ef4444";

function darken(hex, factor = 0.62) {
	const match = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!match) return hex;
	const value = parseInt(match[1], 16);
	const r = Math.round(((value >> 16) & 255) * factor);
	const g = Math.round(((value >> 8) & 255) * factor);
	const b = Math.round((value & 255) * factor);
	return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function prepareChart(input) {
	if (!input || typeof input !== "object" || Array.isArray(input) || !CHART_TYPES.has(input.type)) {
		throw new Error("Chart type must be bar, line, area, pie, scatter, radar, or candlestick.");
	}
	const isCandle = input.type === "candlestick";
	if (
		!Array.isArray(input.data) ||
		!input.data.length ||
		input.data.length > 500 ||
		(!isCandle && (!Array.isArray(input.series) || !input.series.length || input.series.length > 8))
	) {
		throw new Error(
			isCandle ? "Candlestick charts need 2–500 data rows." : "Charts need 1–200 data rows and 1–8 series."
		);
	}
	if (isCandle && input.data.length < 2) {
		throw new Error("Candlestick charts need at least 2 data rows.");
	}
	if (input.type === "radar" && input.data.length < 3) {
		throw new Error("Radar charts need at least 3 data rows.");
	}
	const xAxisKey = input.xAxisKey;
	if (typeof xAxisKey !== "string" || !xAxisKey || xAxisKey.length > 100) {
		throw new Error("Charts need a valid xAxisKey.");
	}
	const keys = new Set([xAxisKey]);
	const series = isCandle ? [] : input.series.map((item, index) => {
		if (!item || typeof item.key !== "string" || !item.key || item.key.length > 100) {
			throw new Error("Each chart series needs a valid key.");
		}
		if (keys.has(item.key) || ["__proto__", "prototype", "constructor"].includes(item.key)) {
			throw new Error("Chart series keys must be unique and distinct from xAxisKey.");
		}
		keys.add(item.key);
		return {
			key: item.key,
			label: typeof item.label === "string" ? item.label.slice(0, 100) : item.key,
			color:
				typeof item.color === "string" && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(item.color)
					? item.color
					: COLORS[index % COLORS.length],
		};
	});
	const rows = input.data.map((row, index) => {
		if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid chart data row.");
		if (isCandle) {
			const result = { [xAxisKey]: String(row[xAxisKey] ?? `Row ${index + 1}`) };
			for (const field of ["open", "high", "low", "close"]) {
				const value = row[field];
				if (typeof value !== "number" || !Number.isFinite(value)) {
					throw new Error(`Candlestick chart requires numeric ${field} values.`);
				}
				result[field] = value;
			}
			if (
				result.low > result.open ||
				result.open > result.high ||
				result.low > result.close ||
				result.close > result.high
			) {
				console.warn(`Candlestick row ${index + 1} violates low ≤ open/close ≤ high; rendering anyway.`);
			}
			return result;
		}
		const xValue = row[xAxisKey];
		if (input.type === "scatter" && (typeof xValue !== "number" || !Number.isFinite(xValue))) {
			throw new Error("Scatter chart xAxisKey values must be numeric.");
		}
		const result = {
			[xAxisKey]: input.type === "scatter" ? xValue : String(xValue ?? "").slice(0, 100),
		};
		if (input.type === "radar") {
			for (const item of series) {
				const value = row[item.key];
				if (typeof value !== "number" || !Number.isFinite(value)) {
					throw new Error("Radar chart values must be numeric.");
				}
			}
		}
		for (const item of series) {
			const value = row[item.key];
			result[item.key] = typeof value === "number" && Number.isFinite(value) ? value : null;
		}
		return result;
	});
	return {
		type: input.type,
		title: typeof input.title === "string" ? input.title.slice(0, 160) : "",
		xAxisKey,
		series,
		rows,
	};
}

function SeriesLegend({ items, hidden, toggle }) {
	return (
		<div className="flex flex-wrap justify-center gap-x-3 gap-y-1 pt-2 text-xs">
			{items.map((item) => (
				<button
					key={item.key}
					type="button"
					onClick={() => toggle(item.key)}
					aria-pressed={!hidden.has(item.key)}
					aria-label={`${hidden.has(item.key) ? "Show" : "Hide"} ${item.label}`}
					className={`inline-flex cursor-pointer items-center gap-1.5 ui-radius-control px-1.5 py-1 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] ${hidden.has(item.key) ? "opacity-45" : ""}`}
				>
					<span
						aria-hidden="true"
						className="h-2.5 w-2.5 ui-radius-small"
						style={{ backgroundColor: item.color }}
					/>
					{item.label}
				</button>
			))}
		</div>
	);
}

export default function InteractiveChart({ data }) {
	const [hidden, setHidden] = useState(() => new Set());
	const prepared = useMemo(() => {
		try {
			return { chart: prepareChart(data) };
		} catch (error) {
			return { error: error.message };
		}
	}, [data]);
	if (prepared.error)
		return (
			<div
				role="alert"
				className="my-3 ui-radius-control border border-[var(--code-border)] bg-[var(--surface)] p-3 text-sm text-[var(--text-muted)]"
			>
				Unable to render chart: invalid JSON schema
			</div>
		);

	const { type, title, xAxisKey, series, rows } = prepared.chart;
	const toggle = (key) =>
		setHidden((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	const legend = (items) => (
		<SeriesLegend
			items={items}
			hidden={hidden}
			toggle={toggle}
		/>
	);
	const tooltip = (
		<Tooltip
			contentStyle={{
				background: "var(--surface-raised)",
				border: "1px solid var(--border)",
				borderRadius: "var(--ui-radius-control)",
				color: "var(--text-primary)",
			}}
			labelStyle={{ color: "var(--text-primary)" }}
			itemStyle={{ color: "var(--text-primary)" }}
		/>
	);
	const axis = {
		tick: { fill: "var(--text-muted)", fontSize: 11 },
		axisLine: { stroke: "var(--border)" },
		tickLine: false,
	};
	const grid = (
		<CartesianGrid
			stroke="var(--border)"
			strokeDasharray="3 3"
		/>
	);
	const pieKey = series[0]?.key;
	const pieItems = rows.map((row, index) => ({
		key: String(index),
		label: row[xAxisKey] || `Slice ${index + 1}`,
		color: COLORS[index % COLORS.length],
	}));
	const pieRows = rows.filter((_, index) => !hidden.has(String(index)));
	const common = { data: rows, margin: { top: 8, right: 16, bottom: 4, left: 0 } };

	const candleShape = (props) => {
		const yScale = useYAxisScale();
		if (!yScale) return null;
		const { payload } = props;
		const color = payload.close >= payload.open ? CANDLE_UP : CANDLE_DOWN;
		const toPx = (value) => {
			const pixel = yScale(value);
			return Number.isFinite(pixel) ? pixel : null;
		};
		const lowPx = toPx(payload.low);
		const highPx = toPx(payload.high);
		const lowBodyPx = toPx(Math.min(payload.open, payload.close));
		const highBodyPx = toPx(Math.max(payload.open, payload.close));
		if (lowPx == null || highPx == null || lowBodyPx == null || highBodyPx == null) return null;
		const centerX = props.x + props.width / 2;
		return (
			<g>
				<line x1={centerX} y1={highPx} x2={centerX} y2={lowPx} stroke={color} strokeWidth={1.5} />
				<rect
					x={props.x}
					y={Math.min(lowBodyPx, highBodyPx)}
					width={props.width}
					height={Math.max(1, Math.abs(highBodyPx - lowBodyPx))}
					fill={color}
				/>
			</g>
		);
	};
	let chart;
	if (type === "candlestick") {
		const candleSize = Math.max(3, Math.floor(400 / rows.length));
		chart = (
			<BarChart {...common}>
				{grid}
				<XAxis dataKey={xAxisKey} {...axis} />
				<YAxis domain={["auto", "auto"]} {...axis} />
				{tooltip}
				<Bar dataKey="close" barSize={candleSize} shape={candleShape} isAnimationActive={false} />
			</BarChart>
		);
	} else if (type === "pie") {
		chart = (
			<PieChart>
				<Pie
					data={pieRows}
					dataKey={pieKey}
					nameKey={xAxisKey}
					cx="50%"
					cy="45%"
					outerRadius="70%"
					isAnimationActive
					animationDuration={300}
				>
					{pieRows.map((row) => (
						<Cell
							key={`${row[xAxisKey]}-${rows.indexOf(row)}`}
							fill={COLORS[rows.indexOf(row) % COLORS.length]}
						/>
					))}
				</Pie>
				{tooltip}
				<Legend content={() => legend(pieItems)} />
			</PieChart>
		);
	} else {
		const children = (
			<>
				{grid}
				<XAxis
					dataKey={xAxisKey}
					{...axis}
				/>
				<YAxis {...axis} />
				{tooltip}
				<Legend content={() => legend(series)} />
				{series.map((item) =>
					type === "bar" ? (
						<Bar
							key={item.key}
							dataKey={item.key}
							name={item.label}
							fill={item.color}
							hide={hidden.has(item.key)}
							isAnimationActive
							animationDuration={300}
						/>
					) : type === "line" ? (
						<Line
							key={item.key}
							type="monotone"
							dataKey={item.key}
							name={item.label}
							stroke={darken(item.color)}
							strokeWidth={2}
							dot={false}
							activeDot={{ r: 4 }}
							hide={hidden.has(item.key)}
							isAnimationActive
							animationDuration={300}
						/>
					) : (
						<Area
							key={item.key}
							type="monotone"
							dataKey={item.key}
							name={item.label}
							stroke={darken(item.color)}
							fill={item.color}
							fillOpacity={0.25}
							strokeWidth={2}
							hide={hidden.has(item.key)}
							isAnimationActive
							animationDuration={300}
						/>
					),
				)}
			</>
		);
		chart =
			type === "scatter" ? (
				<ScatterChart {...common}>
					{grid}
					<XAxis type="number" dataKey={xAxisKey} {...axis} />
					<YAxis {...axis} />
					{tooltip}
					<Legend content={() => legend(series)} />
					{series.map((item) => (
						<Scatter
							key={item.key}
							dataKey={item.key}
							name={item.label}
							fill={item.color}
							stroke={darken(item.color)}
							fillOpacity={0.75}
							isAnimationActive
							animationDuration={300}
						/>
					))}
				</ScatterChart>
			) : type === "radar" ? (
				<RadarChart {...common} cx="50%" cy="50%" outerRadius="70%">
					<PolarGrid stroke="var(--border)" />
					<PolarAngleAxis dataKey={xAxisKey} {...axis} />
					<PolarRadiusAxis {...axis} />
					{tooltip}
					<Legend content={() => legend(series)} />
					{series.map((item) => (
						<Radar
							key={item.key}
							dataKey={item.key}
							name={item.label}
							stroke={item.color}
							fill={item.color}
							fillOpacity={0.3}
							isAnimationActive
							animationDuration={300}
						/>
					))}
				</RadarChart>
			) : type === "bar" ? (
				<BarChart {...common}>{children}</BarChart>
			) : type === "line" ? (
				<LineChart {...common}>{children}</LineChart>
			) : (
				<AreaChart {...common}>{children}</AreaChart>
			);
	}

	return (
		<figure className="my-3 min-w-0 ui-radius-control border border-[var(--code-border)] bg-[var(--surface)] p-3 text-[var(--text-primary)]">
			{title && <figcaption className="mb-2 text-center text-sm font-medium">{title}</figcaption>}
			<div
				role="group"
				aria-label={title || `${type} chart`}
				className="h-72 min-w-0 w-full"
			>
				<ResponsiveContainer
					width="100%"
					height="100%"
				>
					{chart}
				</ResponsiveContainer>
			</div>
		</figure>
	);
}

export { prepareChart };
