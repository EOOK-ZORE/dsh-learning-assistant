// Verify: (1) the tree view renders nesting, (2) a node click returns to the
// list and focuses that card, (3) an external link does NOT navigate the app.
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
await page.waitForTimeout(3000);

// Open the panel via a highlighted word.
const spot = await page.evaluate(() => {
	const root = document.querySelector("[data-conversation-scroll]");
	const box = root.getBoundingClientRect();
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node;
	while ((node = walker.nextNode())) {
		const text = node.nodeValue ?? "";
		const at = text.indexOf("RTOS");
		if (at < 0) continue;
		const range = document.createRange();
		range.setStart(node, at);
		range.setEnd(node, at + 4);
		const rect = range.getBoundingClientRect();
		if (rect.top < box.top + 10 || rect.bottom > box.bottom - 10) continue;
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const caret = document.caretRangeFromPoint(cx, cy);
		if (!caret || caret.startContainer !== node) continue;
		return { x: cx, y: cy };
	}
	return null;
});
if (spot) {
	await page.mouse.click(spot.x, spot.y);
	await page.waitForTimeout(2200);
}

// Switch to the tree view.
const treeBtn = page.getByRole("button", { name: "知识树" }).first();
if ((await treeBtn.count()) === 0) {
	console.log("未找到知识树切换按钮");
	await browser.close();
	process.exit(0);
}
await treeBtn.click();
await page.waitForTimeout(900);

const treeInfo = await page.evaluate(() => {
	const nodes = [...document.querySelectorAll("[data-learning-assistant-tree-node]")];
	const depthOf = (el) => {
		let depth = 0;
		let node = el.parentElement;
		while (node) {
			if (node.tagName === "UL") depth += 1;
			node = node.parentElement;
		}
		return depth - 1;
	};
	return {
		count: nodes.length,
		labels: nodes.map((n) => n.getAttribute("data-learning-assistant-tree-node")),
		depths: nodes.map((n) => `${n.getAttribute("data-learning-assistant-tree-node")}@${depthOf(n)}`),
		maxDepth: Math.max(...nodes.map(depthOf))
	};
});
console.log("知识树节点:", JSON.stringify(treeInfo, null, 1));
await page.screenshot({ path: "/tmp/dsh-tree.png" });

// Click a deep node → list view + that card focused.
const deepNode = page.locator('[data-learning-assistant-tree-node="优先级反转"]').first();
if (await deepNode.count()) {
	await deepNode.click();
	await page.waitForTimeout(2200);
	const afterPick = await page.evaluate(() => {
		const scroller = document.querySelector("[data-learning-assistant-scroll]");
		const card = [...(scroller?.querySelectorAll("[data-learning-assistant-card]") ?? [])].find((n) => n.getAttribute("data-learning-assistant-card") === "优先级反转");
		return {
			backToList: Boolean(scroller),
			cardVisible: card ? (() => {
				const sb = scroller.getBoundingClientRect();
				const cb = card.getBoundingClientRect();
				return cb.top >= sb.top - 4 && cb.bottom <= sb.bottom + 4;
			})() : false
		};
	});
	console.log("点击节点后:", JSON.stringify(afterPick));
}

// External link must not replace the app.
const urlBefore = page.url().replace(/token=[^&]+/, "token=***");
const tabsBefore = await page.evaluate(() => document.querySelectorAll("[data-sidebar-right-tab]").length);
const link = page.locator('a[href*="wikipedia.org"]').first();
if (await link.count()) {
	await link.click();
	await page.waitForTimeout(1800);
	const result = await page.evaluate(() => ({
		url: location.href.replace(/token=[^&]+/, "token=***"),
		tabs: document.querySelectorAll("[data-sidebar-right-tab]").length,
		notice: (document.querySelector("[data-learning-assistant-panel]")?.innerText || "").includes("链接已复制")
	}));
	console.log("外链:", JSON.stringify({
		urlUnchanged: result.url === urlBefore,
		tabsBefore,
		tabsAfter: result.tabs,
		noticeShown: result.notice
	}));
}

console.log("错误:", errors.slice(-3).join(" | ") || "(无)");
await browser.close();
