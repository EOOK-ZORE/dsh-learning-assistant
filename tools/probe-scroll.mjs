// Verify the panel scrolls: the list must have scrollHeight > clientHeight and
// the last card must be reachable inside the viewport.
import { chromium } from "playwright-core";
import fs from "node:fs";

const TOKEN_URL = process.argv[2];
const MEMORY = "/home/y/.dsh/dsh-learning-assistant/terms.json";
const EXE = "/home/y/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(TOKEN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(8000);

// Open the conversation, then land a probe term so the tab opens by itself.
const sessionRow = page.getByText("RTOS 简介", { exact: false }).first();
if (await sessionRow.count()) await sessionRow.click();
await page.waitForTimeout(3000);

const memory = JSON.parse(fs.readFileSync(MEMORY, "utf8"));
memory.terms.unshift({
	term: `SCROLLPROBE ${Date.now()}`,
	explanation: "探针词条，用于测量滚动。",
	category: "probe",
	count: 1,
	firstSeen: new Date().toISOString(),
	lastSeen: new Date().toISOString(),
	tree: [{ label: "probe" }],
	links: []
});
fs.writeFileSync(MEMORY, JSON.stringify(memory, null, 2));
await page.waitForTimeout(9000);

const before = await page.evaluate(() => {
	const root = document.querySelector("[data-learning-assistant-panel]");
	const scroller = document.querySelector("[data-learning-assistant-scroll]");
	if (!root || !scroller) return { found: false };
	return {
		found: true,
		scrollerOverflow: getComputedStyle(scroller).overflowY,
		clientH: scroller.clientHeight,
		scrollH: scroller.scrollHeight,
		canScroll: scroller.scrollHeight > scroller.clientHeight + 4,
		headerPinned: Boolean(root.firstElementChild?.tagName === "HEADER"),
		headerClipped: (() => {
			const header = root.firstElementChild;
			const last = header.lastElementChild;
			if (!header || !last) return null;
			return last.getBoundingClientRect().bottom > header.getBoundingClientRect().bottom + 1;
		})(),
		headerH: root.firstElementChild?.clientHeight ?? 0
	};
});
console.log("滚动容器:", JSON.stringify(before));

// Scroll to the bottom and confirm the last card is on screen.
const after = await page.evaluate(async () => {
	const scroller = document.querySelector("[data-learning-assistant-scroll]");
	if (!scroller) return { ok: false };
	scroller.scrollTop = scroller.scrollHeight;
	await new Promise((r) => setTimeout(r, 400));
	const cards = scroller.querySelectorAll("article");
	const last = cards[cards.length - 1];
	const rect = last?.getBoundingClientRect();
	return {
		ok: true,
		scrollTop: Math.round(scroller.scrollTop),
		cards: cards.length,
		lastCardVisible: rect ? rect.top < window.innerHeight && rect.bottom > 0 : false,
		lastCardTop: rect ? Math.round(rect.top) : null,
		headerStillVisible: Boolean(document.body.innerText.includes("解释倾向"))
	};
});
console.log("滚到底部:", JSON.stringify(after));
console.log("错误:", errors.slice(-3).join(" | ") || "(无)");
await page.screenshot({ path: "/tmp/dsh-scrolled.png", fullPage: false });
console.log("截图: /tmp/dsh-scrolled.png");
await browser.close();
