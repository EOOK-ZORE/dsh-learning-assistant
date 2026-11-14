// Click the sidebar row and verify the panel renders with real terms.
import { chromium } from "playwright-core";

const TOKEN_URL = process.argv[2];
const EXE = "/home/y/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (err) => errors.push(err.message));
page.on("console", (msg) => {
	if (msg.type() === "error" || msg.type() === "warning") errors.push(`${msg.type()}: ${msg.text()}`);
});

await page.goto(TOKEN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(8000);

const row = page.locator('button[aria-label="术语"]');
const rowCount = await row.count();
console.log("侧栏行数量:", rowCount);
if (rowCount > 0) await row.first().click();
await page.waitForTimeout(3500);

const panel = await page.evaluate(() => {
  const body = document.body.innerText;
  return {
    hasHeading: body.includes("术语向导"),
    hasLevelControl: body.includes("我的水平"),
    hasStrictness: body.includes("解释倾向"),
    termNames: ["RTOS", "抢占式优先级调度", "优先级反转", "KV Cache"].filter((t) => body.includes(t)),
    hasTreeLabel: body.includes("学习路径"),
    hasWikiLink: Boolean(document.querySelector('a[href*="wikipedia.org"]')),
    hasNoopener: [...document.querySelectorAll("a")].every((a) => !a.target || a.rel.includes("noopener")),
    bodySlice: body.slice(0, 700)
  };
});

console.log("=== 面板检查 ===");
console.log(JSON.stringify(panel, null, 2));
console.log("=== 错误/警告 ===");
console.log(errors.slice(-10).join("\n") || "(无)");
await page.screenshot({ path: "/tmp/dsh-panel.png", fullPage: false });
console.log("截图: /tmp/dsh-panel.png");
await browser.close();
