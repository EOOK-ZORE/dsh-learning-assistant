// Inspect the panel's container chain: who clips, who should scroll.
import { chromium } from "playwright-core";
import fs from "node:fs";

const TOKEN_URL = process.argv[2];
const MEMORY = "/home/y/.dsh/dsh-learning-assistant/terms.json";
const EXE = "/home/y/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto(TOKEN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(8000);

// Force the panel open with a throwaway term.
const memory = JSON.parse(fs.readFileSync(MEMORY, "utf8"));
memory.terms.unshift({
	term: `SCROLLPROBE ${Date.now()}`,
	explanation: "探针词条，用于测量滚动容器。",
	category: "probe",
	count: 1,
	firstSeen: new Date().toISOString(),
	lastSeen: new Date().toISOString(),
	tree: [{ label: "probe" }],
	links: []
});
fs.writeFileSync(MEMORY, JSON.stringify(memory, null, 2));
await page.waitForTimeout(9000);

const chain = await page.evaluate(() => {
	const heading = [...document.querySelectorAll("h1,h2,div")].find((el) => el.textContent?.trim() === "术语向导");
	if (!heading) return { error: "heading not found" };
	const out = [];
	let node = heading;
	for (let i = 0; i < 9 && node; i += 1) {
		const cs = getComputedStyle(node);
		const r = node.getBoundingClientRect();
		out.push({
			level: i,
			tag: node.tagName,
			attrs: [...node.attributes].filter((a) => /^data-|^class$/.test(a.name)).map((a) => `${a.name}="${a.value.slice(0, 46)}"`).join(" "),
			clientH: node.clientHeight,
			scrollH: node.scrollHeight,
			overflowY: cs.overflowY,
			display: cs.display,
			flex: cs.flexDirection,
			height: cs.height,
			minHeight: cs.minHeight,
			rectH: Math.round(r.height),
			rectTop: Math.round(r.top),
			rectBottom: Math.round(r.bottom)
		});
		node = node.parentElement;
	}
	// Can any ancestor actually scroll?
	const scrollers = out.filter((l) => l.scrollH > l.clientH + 2 && /auto|scroll/.test(l.overflowY));
	return { chain: out, scrollableAncestors: scrollers.length, viewportH: window.innerHeight };
});

console.log(JSON.stringify(chain, null, 2));
await browser.close();
