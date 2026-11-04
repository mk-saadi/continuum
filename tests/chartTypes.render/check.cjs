// Playwright script: loads the verification page (with bundle inlined) and reports
// per-section render results plus captured console errors/warnings.
async (page) => {
	const fs = require("fs");
	const dir = "/home/mk_saadi/projects/persona-projects/llm-electron/tests/chartTypes.render";
	const html = fs.readFileSync(dir + "/index.html", "utf8").replace(/<script src="\.\/bundle\.js"><\/script>/, "");
	const bundle = fs.readFileSync(dir + "/bundle.js", "utf8");
	const guard =
		"<script>window.__errs=[];window.__warns=[];window.addEventListener('error',e=>{window.__errs.push(String((e.error&&e.error.stack)||e.message))});const oe=console.error.bind(console);console.error=(...a)=>{window.__errs.push(a.map(String).join(' '));oe(...a)};const ow=console.warn.bind(console);console.warn=(...a)=>{window.__warns.push(a.map(String).join(' '));ow(...a)}</script>";
	const script = "<script>" + bundle + "</script>";
	await page.setContent(html.replace("</body>", guard + script + "</body>"), { waitUntil: "load" });
	await new Promise((r) => setTimeout(r, 1500));
	return page.evaluate(() => {
		const sections = [...document.querySelectorAll("section")].map((s) => {
			const svg = s.querySelector("svg");
			const alertEl = s.querySelector('[role="alert"]');
			return {
				id: s.id,
				hasSvg: !!svg,
				svgSize: svg ? svg.getAttribute("width") + "x" + svg.getAttribute("height") : null,
				rects: svg ? svg.querySelectorAll("rect").length : 0,
				circles: svg ? svg.querySelectorAll("circle").length : 0,
				lines: svg ? svg.querySelectorAll("line").length : 0,
				polygons: svg ? svg.querySelectorAll("polygon").length : 0,
				paths: svg ? svg.querySelectorAll("path").length : 0,
				legendButtons: s.querySelectorAll('button[aria-pressed]').length,
				alert: alertEl ? alertEl.textContent : null,
			};
		});
		return { sections, errs: window.__errs.slice(0, 30), warns: window.__warns.slice(0, 30) };
	});
};
