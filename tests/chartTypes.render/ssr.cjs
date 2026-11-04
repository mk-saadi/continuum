// Node SSR smoke test: renders InteractiveChart for each type and checks the
// output tree. No browser, no DOM layout — verifies no runtime errors during
// component render, correct alert vs. figure output, and clean console.
const { renderToStaticMarkup } = require("react-dom/server");
const React = require("react");
const InteractiveChart = require("../../src/components/InteractiveChart.jsx").default;

const VALID = {
	bar: {
		type: "bar",
		xAxisKey: "month",
		series: [{ key: "revenue", label: "Revenue" }],
		data: [
			{ month: "Jan", revenue: 120 },
			{ month: "Feb", revenue: 180 },
		],
	},
	line: {
		type: "line",
		xAxisKey: "month",
		series: [{ key: "revenue", label: "Revenue" }],
		data: [
			{ month: "Jan", revenue: 120 },
			{ month: "Feb", revenue: 180 },
		],
	},
	area: {
		type: "area",
		xAxisKey: "month",
		series: [{ key: "revenue", label: "Revenue" }],
		data: [
			{ month: "Jan", revenue: 120 },
			{ month: "Feb", revenue: 180 },
		],
	},
	pie: {
		type: "pie",
		xAxisKey: "label",
		series: [{ key: "value", label: "Value" }],
		data: [
			{ label: "A", value: 30 },
			{ label: "B", value: 50 },
		],
	},
	scatter: {
		type: "scatter",
		xAxisKey: "x",
		series: [{ key: "a", label: "A" }],
		data: [
			{ x: 1, a: 2 },
			{ x: 2, a: 8 },
			{ x: 3, a: 5 },
		],
	},
	radar: {
		type: "radar",
		xAxisKey: "dim",
		series: [{ key: "v", label: "V" }],
		data: [
			{ dim: "A", v: 1 },
			{ dim: "B", v: 2 },
			{ dim: "C", v: 3 },
		],
	},
	candlestick: {
		type: "candlestick",
		xAxisKey: "period",
		data: [
			{ period: "2024-01", open: 100, high: 110, low: 95, close: 105 },
			{ period: "2024-02", open: 105, high: 112, low: 98, close: 101 },
		],
	},
	candlestick500: {
		type: "candlestick",
		xAxisKey: "period",
		data: Array.from({ length: 500 }, (_, i) => ({
			period: `d${i + 1}`,
			open: 100 + (i % 5),
			high: 110 + (i % 5),
			low: 95 + (i % 5),
			close: 105 + (i % 5),
		})),
	},
};

const INVALID = {
	scatterNonNumericX: {
		type: "scatter",
		xAxisKey: "x",
		series: [{ key: "a" }],
		data: [{ x: "abc", a: 1 }],
	},
	radarTooFew: {
		type: "radar",
		xAxisKey: "dim",
		series: [{ key: "v" }],
		data: [
			{ dim: "A", v: 1 },
			{ dim: "B", v: 2 },
		],
	},
	candleOneRow: {
		type: "candlestick",
		xAxisKey: "period",
		data: [{ period: "a", open: 1, high: 2, low: 0, close: 1.5 }],
	},
	candlestick501: {
		type: "candlestick",
		xAxisKey: "period",
		data: Array.from({ length: 501 }, (_, i) => ({
			period: `d${i + 1}`,
			open: 1,
			high: 2,
			low: 0,
			close: 1.5,
		})),
	},
	unknownType: {
		type: "donut",
		xAxisKey: "p",
		series: [{ key: "k" }],
		data: [{ p: "1", k: 1 }],
	},
};

let failures = 0;
const consoleErrors = [];
const originalError = console.error;
const originalWarn = console.warn;
console.error = (...args) => {
	consoleErrors.push(args.map(String).join(" "));
	originalError(...args);
};
console.warn = () => {};

for (const [name, data] of Object.entries(VALID)) {
	try {
		const html = renderToStaticMarkup(React.createElement(InteractiveChart, { data }));
		const ok = html.includes("<figure") && !html.includes("Unable to render chart");
		console.log(`${ok ? "PASS" : "FAIL"} ssr-render ${name}`);
		if (!ok) failures += 1;
	} catch (error) {
		failures += 1;
		console.error(`FAIL ssr-render ${name}: ${error.message}`);
	}
}
for (const [name, data] of Object.entries(INVALID)) {
	try {
		const html = renderToStaticMarkup(React.createElement(InteractiveChart, { data }));
		const ok = html.includes("Unable to render chart: invalid JSON schema");
		console.log(`${ok ? "PASS" : "FAIL"} ssr-alert ${name}`);
		if (!ok) failures += 1;
	} catch (error) {
		failures += 1;
		console.error(`FAIL ssr-alert ${name}: ${error.message}`);
	}
}
const unexpected = consoleErrors.filter((line) => !/React does not recognize|useId|Warning: Each child/i.test(line));
console.error = originalError;
console.warn = originalWarn;
if (unexpected.length) {
	failures += 1;
	console.error(`FAIL console errors: ${unexpected.join(" | ")}`);
}
if (failures) {
	console.error(`${failures} SSR check(s) failed`);
	process.exit(1);
}
console.log("All SSR render checks passed.");
