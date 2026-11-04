import React from "react";
import { createRoot } from "react-dom/client";
import InteractiveChart from "../../src/components/InteractiveChart.jsx";

const VALID = [
	{
		type: "bar",
		title: "bar",
		xAxisKey: "month",
		series: [{ key: "revenue", label: "Revenue", color: "#a78bfa" }],
		data: [
			{ month: "Jan", revenue: 120 },
			{ month: "Feb", revenue: 180 },
			{ month: "Mar", revenue: 90 },
		],
	},
	{
		type: "line",
		title: "line",
		xAxisKey: "month",
		series: [
			{ key: "revenue", label: "Revenue", color: "#A8D8EA" },
			{ key: "costs", label: "Costs", color: "#F7C6D0" },
		],
		data: [
			{ month: "Jan", revenue: 120, costs: 60 },
			{ month: "Feb", revenue: 180, costs: 90 },
			{ month: "Mar", revenue: 90, costs: 50 },
		],
	},
	{
		type: "area",
		title: "area",
		xAxisKey: "month",
		series: [{ key: "revenue", label: "Revenue", color: "#C9E4C5" }],
		data: [
			{ month: "Jan", revenue: 120 },
			{ month: "Feb", revenue: 180 },
			{ month: "Mar", revenue: 90 },
		],
	},
	{
		type: "pie",
		title: "pie",
		xAxisKey: "label",
		series: [{ key: "value", label: "Value" }],
		data: [
			{ label: "A", value: 30 },
			{ label: "B", value: 50 },
			{ label: "C", value: 20 },
		],
	},
	{
		type: "scatter",
		title: "scatter",
		xAxisKey: "x",
		series: [
			{ key: "a", label: "A", color: "#A8D8EA" },
			{ key: "b", label: "B", color: "#F7C6D0" },
		],
		data: [
			{ x: 1, a: 2, b: 5 },
			{ x: 2, a: 8, b: 3 },
			{ x: 3, a: 5, b: 9 },
			{ x: 4, a: 1, b: 4 },
			{ x: 5, a: 7, b: 2 },
		],
	},
	{
		type: "radar",
		title: "radar",
		xAxisKey: "dim",
		series: [
			{ key: "alpha", label: "Alpha", color: "#A8D8EA" },
			{ key: "beta", label: "Beta", color: "#FDE2B3" },
		],
		data: [
			{ dim: "Speed", alpha: 80, beta: 40 },
			{ dim: "Power", alpha: 50, beta: 70 },
			{ dim: "Range", alpha: 30, beta: 90 },
			{ dim: "Agility", alpha: 60, beta: 55 },
		],
	},
	{
		type: "candlestick",
		title: "candlestick",
		xAxisKey: "period",
		series: [{ key: "open", label: "ignored for candlestick" }],
		data: [
			{ period: "2024-01", open: 100, high: 110, low: 95, close: 105 },
			{ period: "2024-02", open: 105, high: 112, low: 98, close: 101 },
			{ period: "2024-03", open: 101, high: 120, low: 99, close: 118 },
			{ period: "2024-04", open: 118, high: 125, low: 108, close: 110 },
		],
	},
];

const INVALID = [
	// 0: scatter with non-numeric x
	{
		type: "scatter",
		xAxisKey: "x",
		series: [{ key: "a", label: "A" }],
		data: [
			{ x: "abc", a: 1 },
			{ x: 2, a: 2 },
		],
	},
	// 1: radar with only 2 rows
	{
		type: "radar",
		xAxisKey: "dim",
		series: [{ key: "v", label: "V" }],
		data: [
			{ dim: "A", v: 1 },
			{ dim: "B", v: 2 },
		],
	},
	// 2: candlestick with a single row
	{
		type: "candlestick",
		xAxisKey: "period",
		data: [{ period: "2024-01", open: 1, high: 2, low: 0, close: 1.5 }],
	},
	{
		type: "candlestick-500",
		title: "candlestick-500",
		xAxisKey: "period",
		data: Array.from({ length: 500 }, (_, i) => ({
			period: `d${i + 1}`,
			open: 100 + (i % 5),
			high: 110 + (i % 5),
			low: 95 + (i % 5),
			close: 105 + (i % 5),
		})),
	},
	// 3: candlestick with a non-numeric field
	{
		type: "candlestick",
		xAxisKey: "period",
		data: [
			{ period: "a", open: 1, high: 2, low: 0, close: 1.5 },
			{ period: "b", open: "x", high: 2, low: 0, close: 1.5 },
		],
	},
	// 4: unknown chart type
	{
		type: "donut",
		xAxisKey: "p",
		series: [{ key: "k" }],
		data: [{ p: "1", k: 1 }],
	},
	// 5: radar with a non-numeric series value
	{
		type: "radar",
		xAxisKey: "dim",
		series: [{ key: "v", label: "V" }],
		data: [
			{ dim: "A", v: 1 },
			{ dim: "B", v: "x" },
			{ dim: "C", v: 3 },
		],
	},
];

function Section({ name, chart }) {
	return (
		<section id={name}>
			<h3>{name}</h3>
			{chart}
		</section>
	);
}

createRoot(document.getElementById("root")).render(
	<div>
		{VALID.map((d) => (
			<Section key={d.type} name={d.type} chart={<InteractiveChart data={d} />} />
		))}
		{INVALID.map((d, i) => (
			<Section key={`invalid-${i}`} name={`invalid-${i}`} chart={<InteractiveChart data={d} />} />
		))}
	</div>
);
