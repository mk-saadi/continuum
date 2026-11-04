// Node-side validation test for the new chart types. Run via esbuild bundle:
// node_modules/.bin/esbuild validate.cjs --bundle --platform=node --outfile=validate.bundle.cjs --log-level=error && node validate.bundle.cjs
const assert = require("node:assert");
const { prepareChart } = require("../../src/components/InteractiveChart.jsx");

const cases = [
	[
		"scatter valid",
		{
			type: "scatter",
			xAxisKey: "x",
			series: [{ key: "a", label: "A" }, { key: "b", label: "B", color: "#gggg" }],
			data: [
				{ x: 1, a: 2, b: 5 },
				{ x: 2, a: 8, b: null },
			],
		},
		(chart) => {
			assert.strictEqual(chart.type, "scatter");
			assert.strictEqual(chart.rows[0].x, 1);
			assert.strictEqual(chart.rows[1].b, null);
			assert.strictEqual(chart.series[1].color, "#F7C6D0"); // invalid color falls back to pastel
		},
	],
	[
		"scatter rejects non-numeric x",
		{ type: "scatter", xAxisKey: "x", series: [{ key: "a" }], data: [{ x: "abc", a: 1 }] },
		() => assert.fail("should have thrown"),
		"Scatter chart xAxisKey values must be numeric.",
	],
	[
		"radar valid",
		{
			type: "radar",
			xAxisKey: "dim",
			series: [{ key: "v", label: "V" }],
			data: [
				{ dim: "A", v: 1 },
				{ dim: "B", v: 2 },
				{ dim: "C", v: 3 },
			],
		},
		(chart) => assert.strictEqual(chart.rows.length, 3),
	],
	[
		"radar rejects 2 rows",
		{
			type: "radar",
			xAxisKey: "dim",
			series: [{ key: "v" }],
			data: [
				{ dim: "A", v: 1 },
				{ dim: "B", v: 2 },
			],
		},
		() => assert.fail("should have thrown"),
		"Radar charts need at least 3 data rows.",
	],
	[
		"radar rejects non-numeric value",
		{
			type: "radar",
			xAxisKey: "dim",
			series: [{ key: "v" }],
			data: [
				{ dim: "A", v: 1 },
				{ dim: "B", v: "x" },
				{ dim: "C", v: 3 },
			],
		},
		() => assert.fail("should have thrown"),
		"Radar chart values must be numeric.",
	],
	[
		"candlestick valid (series ignored)",
		{
			type: "candlestick",
			xAxisKey: "period",
			series: [{ key: "open", label: "ignored" }],
			data: [
				{ period: "2024-01", open: 100, high: 110, low: 95, close: 105 },
				{ period: "2024-02", open: 105, high: 112, low: 98, close: 101 },
			],
		},
		(chart) => {
			assert.strictEqual(chart.series.length, 0);
			assert.strictEqual(chart.rows[0].close, 105);
		},
	],
	[
		"candlestick rejects 1 row",
		{
			type: "candlestick",
			xAxisKey: "period",
			data: [{ period: "a", open: 1, high: 2, low: 0, close: 1.5 }],
		},
		() => assert.fail("should have thrown"),
		"Candlestick charts need at least 2 data rows.",
	],
	[
		"candlestick rejects non-numeric field",
		{
			type: "candlestick",
			xAxisKey: "period",
			data: [
				{ period: "a", open: 1, high: 2, low: 0, close: 1.5 },
				{ period: "b", open: "x", high: 2, low: 0, close: 1.5 },
			],
		},
		() => assert.fail("should have thrown"),
		"Candlestick chart requires numeric open values.",
	],
	[
		"candlestick accepts 500 rows (limit boundary)",
		{
			type: "candlestick",
			xAxisKey: "period",
			data: Array.from({ length: 500 }, (_, i) => ({
				period: `d${i + 1}`,
				open: 1,
				high: 2,
				low: 0,
				close: 1.5,
			})),
		},
		(chart) => assert.strictEqual(chart.rows.length, 500),
	],
	[
		"candlestick rejects 501 rows",
		{
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
		() => assert.fail("should have thrown"),
		"Candlestick charts need 2–500 data rows.",
	],
	[
		"unknown type rejected",
		{ type: "donut", xAxisKey: "p", series: [{ key: "k" }], data: [{ p: "1", k: 1 }] },
		() => assert.fail("should have thrown"),
		"Chart type must be bar, line, area, pie, scatter, radar, or candlestick.",
	],
	[
		"bar regression: still valid",
		{
			type: "bar",
			xAxisKey: "month",
			series: [{ key: "revenue", label: "Revenue", color: "#a78bfa" }],
			data: [
				{ month: "Jan", revenue: 120 },
				{ month: "Feb", revenue: 180 },
			],
		},
		(chart) => assert.strictEqual(chart.rows[1].revenue, 180),
	],
];

let failures = 0;
for (const [name, input, onOk, expectedMessage] of cases) {
	try {
		const chart = prepareChart(input);
		if (expectedMessage) {
			failures += 1;
			console.error(`FAIL ${name}: expected throw "${expectedMessage}" but none was thrown`);
		} else {
			onOk(chart);
			console.log(`PASS ${name}`);
		}
	} catch (error) {
		if (!expectedMessage) {
			failures += 1;
			console.error(`FAIL ${name}: unexpected error: ${error.message}`);
		} else if (error.message !== expectedMessage) {
			failures += 1;
			console.error(`FAIL ${name}: message mismatch: got "${error.message}", want "${expectedMessage}"`);
		} else {
			console.log(`PASS ${name} (rejected with: ${error.message})`);
		}
	}
}
if (failures) {
	console.error(`${failures} validation check(s) failed`);
	process.exit(1);
}
console.log("All validation checks passed.");
