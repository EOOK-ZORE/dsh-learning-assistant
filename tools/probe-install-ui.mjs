import { chromium } from "playwright-core";

const url = process.argv[2];
const spec = process.argv[3] || "/home/y/2026-11-13-11-29-22/dsh-plugin-term-guide";

const b = await chromium.launch({ executablePath: "/home/y/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
const logs = [];
p.on("console", (m) => logs.push("[" + m.type() + "] " + m.text().slice(0, 160)));

await p.goto(url, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(9000);

// open the Plugins page from the left rail
const rail = p.getByText("插件", { exact: true }).first();
console.log("左侧「插件」入口:", await rail.count());
if (await rail.count()) {
	await rail.click();
	await p.waitForTimeout(2500);
}

// the add button on the plugins page
const addBtn = p.getByText("添加插件", { exact: false }).first();
console.log("「添加插件」按钮:", await addBtn.count());
if (await addBtn.count()) {
	await addBtn.click();
	await p.waitForTimeout(1500);
}

const input = p.locator('input[placeholder*="dsh-plugin"]').first();
console.log("输入框:", await input.count());
if (await input.count()) {
	await input.fill(spec);
	await p.waitForTimeout(400);
	await p.screenshot({ path: "/tmp/dsh-add-filled.png" });
	const install = p.getByRole("button", { name: "安装", exact: true }).first();
	console.log("「安装」按钮:", await install.count());
	if (await install.count()) {
		await install.click();
		await p.waitForTimeout(12000);
	}
	const result = await p.evaluate(() => (document.body.innerText || "").slice(0, 1200));
	console.log("=== 安装后页面文本（截取）===");
	console.log(result);
	await p.screenshot({ path: "/tmp/dsh-add-result.png" });
}
console.log("logs:", logs.slice(-6).join(" | ") || "(none)");
await b.close();
