// Render the REAL panel bundle to static HTML for a quick visual look.
//
// Why this exists: the panel only mounts inside the running dsh page, and
// restarting the app to look at one padding tweak is too slow. This loads
// `lib/client.js` exactly as the Client module system does, applies it to a
// stub context, renders both switch states with a serializing React shim, and
// writes `.preview/panel.html`. It is a rendering aid, not a test: styles are
// inline and the surrounding chrome is a stand-in for the sidebar.
//
// Usage:
//   node tools/preview-panel.mjs [out.html]

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.resolve(process.argv[2] ?? path.join(pluginDir, ".preview", "panel.html"));

// ---- load the bundle the way the page does ----
const code = fs.readFileSync(path.join(pluginDir, "lib", "client.js"), "utf8");
const captured = {};
const sandbox = {
	window: { __ModuleLoader__: { load: (descriptor) => (captured.descriptor = descriptor) } },
	console: { log() {}, warn() {}, error() {} },
	setInterval: () => 0,
	clearInterval: () => {},
	setTimeout: () => 0,
	clearTimeout: () => {}
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
if (captured.descriptor === undefined) throw new Error("preview: bundle did not register");

// ---- the smallest React that can serialize one static render ----
const UNITLESS = new Set(["opacity", "fontWeight", "zIndex", "lineHeight", "flex", "flexGrow", "flexShrink", "WebkitLineClamp", "order", "aspectRatio", "tabIndex"]);

/** React element → HTML string. Inline styles only, no event handlers. */
const React = {
	createElement: (type, props, ...children) => {
		if (typeof type === "function") return type({ ...(props ?? {}), children });
		return { type, props: props ?? {}, children };
	},
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: () => {},
	useLayoutEffect: () => {}
};

const voidTags = new Set(["input", "br", "hr", "img", "path", "circle", "rect", "use"]);

function cssValue(key, value) {
	if (typeof value === "number" && !UNITLESS.has(key)) return `${value}px`;
	return String(value);
}

function styleAttr(style) {
	if (style === undefined || style === null || typeof style !== "object") return "";
	const parts = [];
	for (const [key, value] of Object.entries(style)) {
		if (value === undefined || value === null || value === "") continue;
		if (key === "WebkitLineClamp") {
			parts.push(`-webkit-line-clamp:${cssValue(key, value)}`);
			continue;
		}
		const name = key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
		parts.push(`${name}:${cssValue(key, value)}`);
	}
	return parts.length === 0 ? "" : ` style="${parts.join(";")}"`;
}

function attr(name, value) {
	if (value === undefined || value === null || value === false) return "";
	if (name === "style") return styleAttr(value);
	if (name === "children" || typeof value === "function" || name.startsWith("on")) return "";
	if (value === true) return ` ${name}`;
	if (name === "className") return ` class="${String(value)}"`;
	return ` ${name}="${String(value).replace(/"/g, "&quot;")}"`;
}

function escapeHtml(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(node) {
	if (node === null || node === undefined || node === false || node === true) return "";
	if (typeof node === "string" || typeof node === "number") return escapeHtml(node);
	if (Array.isArray(node)) return node.map(render).join("");
	const { type, props, children } = node;
	const attrs = Object.entries(props).map(([name, value]) => attr(name, value)).join("");
	const inner = (children ?? []).map(render).join("");
	if (voidTags.has(type) && inner === "") return `<${type}${attrs}>`;
	return `<${type}${attrs}>${inner}</${type}>`;
}

// ---- mount both switch states ----
const mod = captured.descriptor.factory((spec) => {
	if (spec === "react") return React;
	throw new Error(`unexpected require: ${spec}`);
});
const registered = [];
let panelContextSeen = null;
mod.apply({
	slots: {
		inject: (_name, factory) => factory(),
		register: (definition, component) => {
			registered.push({ definition, component });
			return () => {};
		}
	},
	sidebarRightTabs: { register: () => () => {} },
	sidebarRight: { openTab: () => null },
	effect: (fn) => {
		fn();
		return () => {};
	}
});
const panel = registered.find((entry) => entry.definition.name === "sidebar.right.pane.tab")?.component;
if (panel === undefined) throw new Error("preview: panel slot was not registered");
panelContextSeen = mod.panelContext;

const sampleTerms = [
	{
		term: "KV Cache",
		explanation: "把算过的注意力键值存起来复用，避免每步重算。",
		category: "机器学习",
		count: 2,
		tree: [
			{ label: "Transformer 自注意力", note: "每个 token 都要和前面所有 token 算相关性。" },
			{ label: "推理时逐步生成", note: "每生成一个 token 都要重算前面的注意力。" },
			{ label: "KV Cache", note: "把 K、V 缓存下来，只算新增部分。" }
		],
		links: [{ label: "维基百科", url: "https://zh.wikipedia.org/wiki/Special:Search?search=KV%20Cache" }]
	},
	{
		term: "注意力机制",
		explanation: "让模型按相关性给上下文分配权重的方法。",
		category: "机器学习",
		parent: "Transformer 自注意力",
		tree: [{ label: "加权求和", note: "最朴素的信息汇聚方式。" }, { label: "注意力机制" }],
		links: [{ label: "Google", url: "https://www.google.com/search?q=attention" }]
	}
];

function panelHtml(state) {
	panelContextSeen.store.set({ terms: sampleTerms, level: "intermediate", strictness: 55, error: null, ...state });
	return render(panel({ store: panelContextSeen.store, api: panelContextSeen.api }));
}

const onHtml = panelHtml({ enabled: true });
const offHtml = panelHtml({ enabled: false });
const emptyOffHtml = panelHtml({ enabled: false, terms: [] });

// The conversation-header entry, in both states: it is the only place the user
// can see the switch before opening the panel.
const entry = registered.find((item) => item.definition.id === "learning-assistant-entry")?.component;
function entryHtml(state) {
	panelContextSeen.store.set({ terms: sampleTerms, level: "intermediate", strictness: 55, error: null, ...state });
	return render(entry());
}
const entryOn = entryHtml({ enabled: true });
const entryOff = entryHtml({ enabled: false, terms: [] });

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>learning-assistant panel preview</title>
<style>
  html, body { margin: 0; background: #0d1117; color: #e6edf3; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  .row { display: flex; gap: 0; align-items: stretch; min-height: 100vh; }
  .col { flex: 0 0 auto; border-right: 1px solid rgba(255,255,255,0.10); display: flex; flex-direction: column; }
  .col.on { width: 400px; }
  .col.off { width: 400px; }
  .col.narrow { width: 340px; }
  .label { padding: 10px 16px; font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #5b6678; border-bottom: 1px solid rgba(255,255,255,0.10); }
  .body { flex: 1 1 auto; min-height: 0; }
  .body > div { height: 100%; }
  .chatbar { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-bottom: 1px solid rgba(255,255,255,0.10); background: #12181f; }
  .chatbar .title { font-size: 13.5px; font-weight: 600; color: #c9d4e2; }
  .chatbar .spacer { flex: 1 1 auto; }
  .chatbar .case { font-size: 11px; color: #7f8c9f; margin-left: 8px; }
</style></head>
<body>
  <div class="chatbar">
    <span class="title">对话标题栏</span>
    <span class="spacer"></span>
    <span class="case">开启（3 个词条）</span>
    ${entryOn}
    <span class="case">关闭</span>
    ${entryOff}
  </div>
  <div class="row">
    <div class="col on"><div class="label">开启 · 400px（enabled: true）</div><div class="body">${onHtml}</div></div>
    <div class="col off"><div class="label">关闭 · 400px（enabled: false）</div><div class="body">${offHtml}</div></div>
    <div class="col narrow"><div class="label">关闭 + 无词条 · 340px</div><div class="body">${emptyOffHtml}</div></div>
  </div>
</body></html>
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, page, "utf8");
console.log(`preview: wrote ${outPath}`);
