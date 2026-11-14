// End-to-end browser check: highlight on an existing conversation, then a new
// term arriving should open the sidebar panel by itself.
import { chromium } from "playwright-core";
import fs from "node:fs";

const TOKEN_URL = process.argv[2];
const MEMORY = "/home/y/.dsh/dsh-learning-assistant/terms.json";
const EXE = "/home/y/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const notFound = [];
page.on("response", (r) => { if (r.status() === 404) notFound.push(r.url()); });
page.on("pageerror", (e) => errors.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
	if (m.type() === "error") errors.push(`console.error ${m.text()}`);
});

await page.goto(TOKEN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(9000);

// 1) Open the existing RTOS conversation.
const sessionRow = page.getByText("RTOS 简介", { exact: false }).first();
if (await sessionRow.count()) await sessionRow.click();
await page.waitForTimeout(4000);

const afterOpen = await page.evaluate(() => {
  const highlight = window.CSS?.highlights?.get?.("learning-assistant") ?? null;
  return {
    panelOpen: document.body.innerText.includes("术语向导"),
    transcriptChars: (document.querySelector("[data-conversation-scroll]")?.innerText ?? "").length,
    highlightRanges: highlight ? [...highlight].length : 0,
    hasStyleRule: [...document.querySelectorAll("style[data-learning-assistant]")].length
  };
});
console.log("打开会话后:", JSON.stringify(afterOpen));

// 2) A new term lands while the panel is closed → it should open by itself.
const memory = JSON.parse(fs.readFileSync(MEMORY, "utf8"));
memory.terms.unshift({
	term: `NMI 不可屏蔽中断 ${Date.now()}`,
	explanation: "专门用于发现程序卡死的倒计时器，超时未喂狗就复位系统。",
	category: "嵌入式系统",
	count: 1,
	firstSeen: new Date().toISOString(),
	lastSeen: new Date().toISOString(),
	tree: [
		{ label: "程序可能卡死", note: "中断风暴、死循环都会让主程序停摆。" },
		{ label: "独立倒计时器", note: "硬件电路自己数数，不依赖主程序。" },
		{ label: "看门狗定时器", note: "主程序定期喂狗；超时未喂则复位，确保设备自恢复。" }
	],
	links: []
});
memory.updatedAt = new Date().toISOString();
fs.writeFileSync(MEMORY, JSON.stringify(memory, null, 2));
console.log("已外部写入一个全新词条");

await page.waitForTimeout(9000);
const afterNew = await page.evaluate(() => ({
  panelOpen: document.body.innerText.includes("术语向导"),
  sawNewTerm: /NMI 不可屏蔽中断/.test(document.body.innerText),
  heading: document.body.innerText.includes("术语向导") ? "已打开" : "未打开"
}));
console.log("新词到达后:", JSON.stringify(afterNew));
console.log("错误:", errors.slice(-5).join(" | ") || "(无)");
console.log("404 资源:", notFound.slice(0, 5).join(" | ") || "(无)");

await page.screenshot({ path: "/tmp/dsh-autopen.png", fullPage: false });
await browser.close();
