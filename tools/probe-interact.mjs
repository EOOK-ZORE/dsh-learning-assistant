// Interaction check:
//   1. click a highlighted word in the transcript → the panel scrolls to its card
//   2. double-click that card → the word pulses in the transcript
import { chromium } from "playwright-core";

const TOKEN_URL = process.argv[2];
const EXE = "/home/y/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const TERM = "RTOS";

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(TOKEN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(9000);

const row = page.getByText("RTOS 简介", { exact: false }).first();
if (await row.count()) await row.click();
await page.waitForTimeout(4000);

// Bring the term into view, then locate a visible occurrence.
await page.evaluate((term) => {
	const root = document.querySelector("[data-conversation-scroll]");
	if (!root) return;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node;
	while ((node = walker.nextNode())) {
		const text = node.nodeValue ?? "";
		const at = text.indexOf(term);
		if (at < 0) continue;
		const range = document.createRange();
		range.setStart(node, at);
		range.setEnd(node, at + term.length);
		const rect = range.getBoundingClientRect();
		const box = root.getBoundingClientRect();
		root.scrollTop += rect.top - box.top - root.clientHeight / 2 + rect.height / 2;
		return;
	}
}, TERM);
await page.waitForTimeout(600);

const spot = await page.evaluate((term) => {
	const root = document.querySelector("[data-conversation-scroll]");
	if (!root) return { error: "no transcript" };
	const box = root.getBoundingClientRect();
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node;
	while ((node = walker.nextNode())) {
		const text = node.nodeValue ?? "";
		const at = text.indexOf(term);
		if (at < 0) continue;
		const range = document.createRange();
		range.setStart(node, at);
		range.setEnd(node, at + term.length);
		const rect = range.getBoundingClientRect();
		if (rect.width < 2) continue;
		if (rect.top < box.top + 10 || rect.bottom > box.bottom - 10) continue;
		// The click must land on the transcript, not on a floating control above it,
		// and the caret must fall inside this very occurrence.
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const hit = document.elementFromPoint(cx, cy);
		if (!hit || !root.contains(hit)) continue;
		const caret = document.caretRangeFromPoint(cx, cy);
		if (!caret || caret.startContainer !== node || caret.startOffset < at || caret.startOffset > at + term.length) continue;
		const h = window.CSS?.highlights?.get?.("term-guide");
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rangeCount: h ? [...h].length : 0, inView: true };
	}
	return { error: "no visible occurrence after scroll" };
}, TERM);

console.log("定位到的高亮词:", JSON.stringify(spot));

if (spot.x === undefined) {
	console.log("跳过点击测试");
} else {
	const before = await page.evaluate(() => ({
		panelOpen: Boolean(document.querySelector("[data-term-guide-panel]")),
		scrollTop: document.querySelector("[data-term-guide-scroll]")?.scrollTop ?? null
	}));
	console.log("点击前:", JSON.stringify(before));

	await page.mouse.click(spot.x, spot.y);
	await page.waitForTimeout(2500);

	const afterClick = await page.evaluate((term) => {
		const scroller = document.querySelector("[data-term-guide-scroll]");
		const card = [...(scroller?.querySelectorAll("[data-term-guide-card]") ?? [])].find((n) => n.getAttribute("data-term-guide-card") === term);
		if (!scroller || !card) return { panelOpen: Boolean(scroller), cardFound: false };
		const sb = scroller.getBoundingClientRect();
		const cb = card.getBoundingClientRect();
		const visible = cb.top >= sb.top - 4 && cb.bottom <= sb.bottom + 4;
		return {
			panelOpen: true,
			cardFound: true,
			cardVisible: visible,
			scrollTop: Math.round(scroller.scrollTop),
			cardTop: Math.round(cb.top - sb.top),
			boxH: Math.round(sb.height),
			transcriptStillThere: Boolean(document.querySelector("[data-conversation-scroll]"))
		};
	}, TERM);
	console.log("点击词后:", JSON.stringify(afterClick));

	// Double-click the card → transcript pulses.
	const convBefore = await page.evaluate(() => document.querySelector("[data-conversation-scroll]").scrollTop);
	const card = page.locator(`[data-term-guide-card="${TERM}"]`).first();
	if ((await card.count()) === 0) {
		console.log("双击跳过：卡片未渲染");
		await browser.close();
		process.exit(0);
	}
	await card.dblclick();
	await page.waitForTimeout(120);
	const flash = await page.evaluate(() => {
		const h = window.CSS?.highlights?.get?.("term-guide-flash");
		return { flashRanges: h ? [...h].length : 0, convScrollTop: Math.round(document.querySelector("[data-conversation-scroll]").scrollTop) };
	});
	console.log("双击卡片后:", JSON.stringify(flash), "| 对话滚动前:", Math.round(convBefore));
	await page.waitForTimeout(1200);
	const flashGone = await page.evaluate(() => Boolean(window.CSS?.highlights?.get?.("term-guide-flash")));
	console.log("闪烁结束后已清除:", !flashGone);
	await page.screenshot({ path: "/tmp/dsh-interact.png", fullPage: false });
}

console.log("错误:", errors.slice(-3).join(" | ") || "(无)");
await browser.close();
