// Builds the browser half of the term guide.
//
// Why a build step exists: the host's client module table hands a bundle a
// synchronous `require` that resolves platform seed words (react) and
// already-registered package factories only. A relative `require("./guide.js")`
// therefore throws at runtime, so the bundle inlines its CommonJS sources behind
// a small local registry — which keeps every source-level `require("./x.js")`
// working verbatim and lets the same files be unit-tested in Node.
//
// Usage:
//   node tools/build-client.mjs [--check]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..");
const coreDir = join(pluginDir, "lib", "core");

/** Modules inlined into the bundle, in dependency order. */
const MODULES = ["guide.js", "highlight.js", "shell.js"];

const TEMPLATE = join(pluginDir, "lib", "client.template.js");
const OUTPUT = join(pluginDir, "lib", "client.js");
const PLACEHOLDER = "/*__MODULES__*/";

const PLATFORM_SEEDS = new Set(["react", "react/jsx-runtime", "react-dom"]);

/**
 * Read one source file, failing loudly with its path.
 * @param path - absolute path.
 * @returns file text.
 */
function read(path) {
	if (!existsSync(path)) throw new Error(`build-client: missing source ${path}`);
	return readFileSync(path, "utf8");
}

/**
 * Reject sources that cannot be inlined: they must be CommonJS and may only
 * import relative siblings or a platform seed.
 * @param name - module file name.
 * @param text - source text.
 */
function assertModuleShape(name, text) {
	if (!/module\.exports\s*=|exports\.[A-Za-z_$]/.test(text)) {
		throw new Error(`build-client: ${name} exports nothing`);
	}
	const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	if (/^\s*import\s/m.test(withoutBlockComments) || /^\s*export\s/m.test(withoutBlockComments)) {
		throw new Error(`build-client: ${name} uses ESM syntax and cannot be inlined`);
	}
	for (const match of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
		const spec = match[1];
		const relative = spec.startsWith("./") && MODULES.includes(spec.slice(2));
		if (!relative && !PLATFORM_SEEDS.has(spec)) {
			throw new Error(`build-client: ${name} requires ${spec}, which is neither a sibling nor a platform seed`);
		}
	}
}

/**
 * Wrap one CommonJS source into the inlined registry.
 * @param name - module file name.
 * @param text - source text.
 * @returns the registry assignment statement.
 */
function wrap(name, text) {
	return `\t\t__tgModules[${JSON.stringify(`./${name}`)}] = (module, exports, require) => {\n${text}\n\t\t};`;
}

const parts = MODULES.map((name) => {
	const text = read(join(coreDir, name));
	assertModuleShape(name, text);
	return wrap(name, text);
});

const template = read(TEMPLATE);
if (!template.includes(PLACEHOLDER)) throw new Error(`build-client: template has no ${PLACEHOLDER}`);
const output = template.replace(PLACEHOLDER, parts.join("\n"));

if (process.argv.includes("--check")) {
	const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
	if (current !== output) {
		console.error("build-client: lib/client.js is stale; run node tools/build-client.mjs");
		process.exit(1);
	}
	console.log("build-client: up to date");
	process.exit(0);
}

writeFileSync(OUTPUT, output);
console.log(`build-client: wrote ${OUTPUT} (${output.length} bytes, ${MODULES.length} modules)`);
