// Regression probe:
//   A. click a word whose card sits deep in the list → the panel must centre it
//   B. double-click that card while the transcript is scrolled far away → the
//      pulse must only start after the transcript scroll stops
import { chromium } from "playwright-core";

const TOKEN_URL = process.argv[2];
const EXE = "/home/y/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(TOKEN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(9000);
const row = page.getByText("RTOS 简介", { exact: false }).first();
if (await row.count()) await row.click();
await page.waitForTimeout(3500);

/** Find a clickable, caret-verified occurrence of `term`, scrolling it into view first. */
async function locate(term) {
	await page.evaluate((t) => {
		const root = document.querySelector("[data-conversation-scroll]");
		const box = root.getBoundingClientRect();
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node;
		while ((node = walker.nextNode())) {
			const text = node.nodeValue ?? "";
			const at = text.indexOf(t);
			if (at < 0) continue;
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + t.length);
			const rect = range.getBoundingClientRect();
			root.scrollTop += rect.top - box.top - root.clientHeight / 2 + rect.height / 2;
			return;
		}
	}, term);
	await page.waitForTimeout(450);
	return page.evaluate((t) => {
		const root = document.querySelector("[data-conversation-scroll]");
		const box = root.getBoundingClientRect();
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node;
		while ((node = walker.nextNode())) {
			const text = node.nodeValue ?? "";
			const at = text.indexOf(t);
			if (at < 0) continue;
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + t.length);
			const rect = range.getBoundingClientRect();
			if (rect.width < 2) continue;
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			if (cy < box.top + 20 || cy > box.bottom - 20) continue;
			const caret = document.caretRangeFromPoint(cx, cy);
			if (!caret || caret.startContainer !== node) continue;
			return { term: t, x: cx, y: cy };
		}
		return null;
	}, term);
}

// Step 1: open the panel by clicking any highlighted word.
const opener = await locate("RTOS");
if (opener === null) {
	console.log("无法定位首个词，退出");
	await browser.close();
	process.exit(0);
}
await page.mouse.click(opener.x, opener.y);
await page.waitForTimeout(2000);

// Step 2: from the deepest card upwards, take the first term that is actually
// highlighted (a term split across inline nodes is not highlighted at all).
const cards = await page.evaluate(() => {
	const scroller = document.querySelector("[data-learning-assistant-scroll]");
	return [...(scroller?.querySelectorAll("[data-learning-assistant-card]") ?? [])].map((n) => n.getAttribute("data-learning-assistant-card"));
});

let chosen = null;
for (let i = cards.length - 1; i >= 1; i -= 1) {
	const term = cards[i];
	if (!term) continue;
	const spot = await locate(term);
	if (spot !== null) {
		chosen = { term, index: i, total: cards.length, spot };
		break;
	}
}
console.log("选中卡片:", chosen === null ? "无" : JSON.stringify({ term: chosen.term, index: chosen.index, total: chosen.total }));

if (chosen !== null) {
	await page.mouse.click(chosen.spot.x, chosen.spot.y);
	await page.waitForTimeout(2600);
	const acc = await page.evaluate((term) => {
		const scroller = document.querySelector("[data-learning-assistant-scroll]");
		const card = [...(scroller?.querySelectorAll("[data-learning-assistant-card]") ?? [])].find((n) => n.getAttribute("data-learning-assistant-card") === term);
		if (!scroller || !card) return { ok: false };
		const sb = scroller.getBoundingClientRect();
		const cb = card.getBoundingClientRect();
		return {
			ok: true,
			offsetFromCenter: Math.round(cb.top + cb.height / 2 - (sb.top + scroller.clientHeight / 2)),
			fullyVisible: cb.top >= sb.top - 2 && cb.bottom <= sb.bottom + 2,
			scrollTop: Math.round(scroller.scrollTop)
		};
	}, chosen.term);
	console.log("A) 点击后卡片定位:", JSON.stringify(acc));

	// B. park the transcript at the top, then double-click the card.
	await page.evaluate(() => {
		document.querySelector("[data-conversation-scroll]").scrollTop = 0;
	});
	await page.waitForTimeout(400);
	await page.evaluate(() => {
		window.__samples = [];
		window.__poll = setInterval(() => {
			const root = document.querySelector("[data-conversation-scroll]");
			const h = CSS.highlights.get("learning-assistant-flash");
			const box = root.getBoundingClientRect();
			const inView = h ? [...h].some((r) => {
				const b = r.getBoundingClientRect();
				return b.top >= box.top - 6 && b.bottom <= box.bottom + 6;
			}) : false;
			window.__samples.push({ flash: h ? [...h].length : 0, inView, scrollTop: Math.round(root.scrollTop) });
		}, 60);
	});
	await page.locator(`[data-learning-assistant-card="${chosen.term}"]`).first().dblclick();
	await page.waitForTimeout(2800);
	const samples = await page.evaluate(() => {
		clearInterval(window.__poll);
		return window.__samples;
	});
	const flashed = samples.filter((sample) => sample.flash > 0);
	const allInView = flashed.length > 0 && flashed.every((sample) => sample.inView);
	console.log("B) 采样(前14):", samples.slice(0, 14).map((s) => `${s.flash}${s.inView ? "v" : "-"}/${s.scrollTop}`).join(" "));
	console.log("B) 闪烁帧数:", flashed.length, "| 每帧词都在视口内:", allInView ? "✅" : "❌ 有帧在视口外");
}

console.log("错误:", errors.slice(-3).join(" | ") || "(无)");
await browser.close();
