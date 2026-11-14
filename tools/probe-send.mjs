// End-to-end judgment probe: send a question in a fresh session and report
// whether explain_terms fired (memory growth) and whether the answer mentions
// the sidebar.
import { chromium } from "playwright-core";

const url = process.argv[2];
const question = process.argv[3] || "我想从事vla行业，需要学习什么";

const b = await chromium.launch({ executablePath: "/home/y/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));

await p.goto(url, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(9000);

// A fresh session keeps the probe from inheriting prior context.
const newChat = p.getByText("新会话", { exact: true }).first();
if (await newChat.count()) {
	await newChat.click();
	await p.waitForTimeout(1500);
}

const box = p.locator("[contenteditable=true]").first();
if ((await box.count()) === 0) {
	console.log("找不到输入框");
	await b.close();
	process.exit(0);
}
await box.click();
await p.keyboard.type(question, { delay: 6 });
await p.waitForTimeout(250);
await p.keyboard.press("Enter");
console.log("已发送:", question);
await p.waitForTimeout(75000);

const after = await p.evaluate(() => {
	const tx = document.querySelector("[data-conversation-scroll]");
	const panel = document.querySelector("[data-learning-assistant-panel]");
	const h = CSS.highlights.get("learning-assistant");
	return {
		answerChars: tx ? tx.innerText.length : 0,
		saysSidebar: tx ? /侧栏补充|已在侧栏/.test(tx.innerText) : false,
		panelTerms: panel ? (panel.innerText.match(/(\d+) 个词条/) || [])[1] || null : null,
		highlightRanges: h ? [...h].length : 0,
		mentionsVLA: tx ? /VLA/i.test(tx.innerText) : false
	};
});
console.log("结果:", JSON.stringify(after));
console.log("errors:", errors.slice(-3).join(" | ") || "(none)");
await p.screenshot({ path: "/tmp/dsh-vla.png" });
await b.close();
