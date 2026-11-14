// Geometry check: after a new term opens the panel, the conversation must stay
// visible and the panel must sit beside it, not on top of it.
import { chromium } from "playwright-core";
import fs from "node:fs";

const TOKEN_URL = process.argv[2];
const MEMORY = "/home/y/.dsh/dsh-plugin-term-guide/terms.json";
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

const before = await page.evaluate(() => ({
	panelOpen: document.body.innerText.includes("术语向导"),
	convChars: (document.querySelector("[data-conversation-scroll]")?.innerText ?? "").length
}));
console.log("打开会话后（未开面板）:", JSON.stringify(before));

// Land a brand-new term so the plugin opens its tab by itself.
const memory = JSON.parse(fs.readFileSync(MEMORY, "utf8"));
const unique = `DMA 传输 ${Date.now()}`;
memory.terms.unshift({
	term: unique,
	explanation: "外设与内存之间不经过 CPU 直接搬运数据的通道。",
	category: "嵌入式系统",
	count: 1,
	firstSeen: new Date().toISOString(),
	lastSeen: new Date().toISOString(),
	tree: [{ label: "CPU 逐字节搬运", note: "占用 CPU 且慢。" }, { label: "DMA 控制器", note: "由硬件自己搬，CPU 去干别的。" }, { label: unique }],
	links: []
});
memory.updatedAt = new Date().toISOString();
fs.writeFileSync(MEMORY, JSON.stringify(memory, null, 2));

await page.waitForTimeout(10000);

const after = await page.evaluate(() => {
	const conv = document.querySelector("[data-conversation-scroll]");
	const heading = [...document.querySelectorAll("h1,h2,div")].find((el) => el.textContent?.trim() === "术语向导");
	// The panel's outermost box: walk up from the heading to the widest container
	// that still belongs to the term list.
	let box = heading;
	for (let i = 0; i < 6 && box?.parentElement; i += 1) box = box.parentElement;
	const convRect = conv?.getBoundingClientRect() ?? null;
	const panelRect = box?.getBoundingClientRect() ?? null;
	const overlap = convRect && panelRect
		? Math.min(convRect.right, panelRect.right) - Math.max(convRect.left, panelRect.left)
		: null;
	return {
		panelOpen: document.body.innerText.includes("术语向导"),
		convVisibleChars: conv?.innerText.length ?? 0,
		convVisible: Boolean(convRect && convRect.width > 100 && convRect.height > 100),
		convRect: convRect && { left: Math.round(convRect.left), right: Math.round(convRect.right), width: Math.round(convRect.width) },
		panelRect: panelRect && { left: Math.round(panelRect.left), right: Math.round(panelRect.right), width: Math.round(panelRect.width) },
		horizontalOverlapPx: overlap === null ? null : Math.round(overlap),
		sawNewTerm: /DMA 传输/.test(document.body.innerText)
	};
});
console.log("新词到达后:", JSON.stringify(after, null, 2));
console.log("错误:", errors.slice(-3).join(" | ") || "(无)");
await page.screenshot({ path: "/tmp/dsh-right-panel.png", fullPage: false });
console.log("截图: /tmp/dsh-right-panel.png");
await browser.close();
