// Headless probe: does the learning-assistant client half actually activate in the page?
import { chromium } from "playwright-core";

const TOKEN_URL = process.argv[2];
const EXE = "/home/y/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleLines = [];
const errors = [];
page.on("console", (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));

await page.goto(TOKEN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(9000);

const report = await page.evaluate(() => {
  const text = (el) => (el?.textContent ?? "").trim();
  const buttons = [...document.querySelectorAll("button, [role=button], a")];
  const termish = buttons.filter((b) => /术语|term/i.test(text(b) + (b.getAttribute("aria-label") ?? "")));
  const globals = Object.keys(window).filter((k) => /BOOT|AUDIT|MODULE/i.test(k));
  const boot = window.__DSH_BOOT__ ?? null;
  const entry = boot?.entries?.find?.((e) => e.id === "dsh-learning-assistant") ?? null;
  return {
    url: location.href.replace(/token=[^&]+/, "token=***"),
    title: document.title,
    bodyText: document.body.innerText.slice(0, 600),
    termishCount: termish.length,
    termishSample: termish.slice(0, 6).map((b) => ({
      tag: b.tagName,
      label: (b.getAttribute("aria-label") ?? "").slice(0, 40),
      text: text(b).slice(0, 40)
    })),
    hasConversationScroll: Boolean(document.querySelector("[data-conversation-scroll]")),
    globals,
    pluginInBootGraph: Boolean(entry),
    modulesLoaded: (() => {
      try {
        const registry = window.__ModuleLoader__;
        return registry ? Object.keys(registry).slice(0, 10) : null;
      } catch {
        return null;
      }
    })(),
    sidebarButtons: buttons.filter((b) => /sidebar|nav/i.test(b.className ?? "")).length
  };
});

console.log("=== 页面报告 ===");
console.log(JSON.stringify(report, null, 2));
console.log("\n=== 控制台（含警告/错误，末尾 25 条）===");
console.log(consoleLines.slice(-25).join("\n") || "(无)");
console.log("\n=== 未捕获异常 ===");
console.log(errors.join("\n") || "(无)");

await page.screenshot({ path: "/tmp/dsh-boot.png", fullPage: false });
console.log("\n截图已存: /tmp/dsh-boot.png");

await browser.close();
