/**
 * Host half of the term guide.
 *
 * It owns three things the page cannot own by itself:
 *  1. the durable memory file, under `$DSH_HOME/dsh-learning-assistant/`;
 *  2. the model-facing `explain_terms` tool plus the system-prompt section that
 *     tells the model when to call it;
 *  3. an HTTP surface on the Web carrier, which the page reads and writes.
 *
 * The merge and normalization rules live in `lib/core/guide.js`, loaded through
 * `createRequire` so the host and the page apply exactly the same rules.
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

const require = createRequire(import.meta.url);
const guide = require("./core/guide.js");

/** The package name; also the row id the patch inserts. */
export const name = "learning-assistant";

/** Required services: tools to register, webServer to serve the panel's data. */
export const inject = ["tools", "webServer"];

/** Deadline for one supplemental explanation call. */
const SUPPLEMENT_TIMEOUT_MS = 45_000;

/** How long to wait for the turn to finish before scanning it. */
const SUPPLEMENT_DEBOUNCE_MS = 2_500;

/** Minimum gap between two supplement passes, across all sessions. */
const SUPPLEMENT_COOLDOWN_MS = 15_000;

/** System prompt for the supplemental explanation call. */
const SUPPLEMENT_SYSTEM = "你是术语补充解释器，只输出 JSON，不写任何多余文字。";

/** Route namespace owned by this plugin. The browser half spells the same string. */
const ROUTE_PREFIX = "/learning-assistant";

/** Largest accepted request body. */
const MAX_BODY_BYTES = 256 * 1024;

/** Prompt section order: after the tool documentation, before the tail. */
const SECTION_ORDER = 150;

/**
 * Resolve the memory file path.
 * @returns absolute path to `terms.json`.
 */
function memoryPath() {
	const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, "dsh-learning-assistant", "terms.json");
}

/**
 * Read the memory file, caching by mtime.
 *
 * Assembly runs once per step, so a stale cache would hide a term the user just
 * forgot; an mtime check keeps that cheap.
 *
 * @param cache - `{ mtimeMs, value }` holder.
 * @param defaults - level and strictness used when the file is absent.
 * @returns the current memory.
 */
function readMemory(cache, defaults) {
	const path = memoryPath();
	try {
		if (!existsSync(path)) {
			cache.mtimeMs = -1;
			if (cache.value === null) cache.value = guide.emptyMemory(defaults.level, defaults.strictness, defaults.enabled);
			return cache.value;
		}
		const stat = require("node:fs").statSync(path);
		if (stat.mtimeMs !== cache.mtimeMs || cache.value === null) {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			cache.value = {
				...guide.emptyMemory(defaults.level, defaults.strictness, defaults.enabled),
				// An older memory file has no `enabled`: the config default decides,
				// and it is off unless the row explicitly turned the guide on.
				enabled: defaults.enabled,
				...parsed,
				terms: Array.isArray(parsed.terms) ? parsed.terms : []
			};
			cache.mtimeMs = stat.mtimeMs;
		}
		return cache.value;
	} catch (error) {
		console.error("[learning-assistant] memory read failed:", error);
		if (cache.value === null) cache.value = guide.emptyMemory(defaults.level, defaults.strictness, defaults.enabled);
		return cache.value;
	}
}

/**
 * Persist memory atomically (write a sibling temp file, then rename).
 * @param memory - the memory to store.
 * @returns the stored memory.
 */
function writeMemory(memory) {
	const path = memoryPath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
	renameSync(temp, path);
	return memory;
}

/**
 * The state the page reads.
 * @param memory - current memory.
 * @returns a JSON-safe payload.
 */
function stateOf(memory) {
	return {
		terms: Array.isArray(memory.terms) ? memory.terms : [],
		level: memory.level,
		strictness: memory.strictness,
		enabled: memory.enabled === true,
		updatedAt: memory.updatedAt
	};
}

/**
 * Read a JSON request body under a byte ceiling.
 * @param req - incoming request.
 * @returns the parsed object, or null when unusable.
 */
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) return null;
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed !== null && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Send one JSON response.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param body - JSON body.
 */
function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text)
	});
	res.end(text);
}

/**
 * Try to contribute a system-prompt section; a composition without the
 * system-prompt service keeps working through the tool description alone.
 *
 * A switched-off guide contributes an EMPTY section on purpose: the assembler
 * drops empty sections, so one registration covers both states and the switch
 * needs no re-registration. `promptCache` is shared with the HTTP surface so a
 * toggle invalidates it instead of leaving stale rules in the prompt for a few
 * seconds.
 *
 * @param ctx - the host context.
 * @param read - reads the current config defaults.
 * @param cache - the memory cache holder.
 * @param isEnabled - whether the guide is on right now.
 * @param promptCache - `{ text, builtAt }` holder shared with the routes.
 */
function contributePrompt(ctx, read, cache, isEnabled, promptCache) {
	ctx.inject(["systemPrompt"], (promptCtx) => {
		promptCtx.effect(
			() =>
				promptCtx.systemPrompt.section({
					name: "learning-assistant",
					order: SECTION_ORDER,
					text: () => {
						// Switched off: no rules reach the model, and the tool below is
						// hidden from its schema at the same time.
						if (!isEnabled()) return "";
						const now = Date.now();
						if (promptCache.text !== "" && now - promptCache.builtAt < 3000) return promptCache.text;
						const memory = readMemory(cache, read());
						const known = guide.summarizeMemory(memory);
						const text = [
							"## 术语向导",
							"回答时，把正文里出现、且用户（水平：" + guide.LEVEL_LABELS[memory.level] + "，严格度 " + memory.strictness + "/100）可能不懂的专业词，用 explain_terms 记到侧栏。",
							(known === "" ? "记忆：无。" : "已收录（不重复）：" + known + "。"),
							"规则：只收该领域专业词、高于用户水平、与问题相关的；每次≤4个；词给≤60字说人话解释 + 3–5节点学习路径 + 隶属(parent)。",
							"「提到一个词」或「想学某方向」不算已掌握，都要解释；缩写默认解释；拿不准就解释。",
							"不要为了用工具改变回答方式；没调用也不要紧，宿主会自动补齐。"
						].join("\n");
						promptCache.text = text;
						promptCache.builtAt = now;
						return text;
					}
				}),
			"learning-assistant: system prompt section"
		);
	});
}

/**
 * Pull one JSON object out of a model reply, fenced or bare.
 * @param text - the model output.
 * @returns the parsed object, or null.
 */
function parseJsonLoose(text) {
	if (typeof text !== "string") return null;
	let body = text.trim();
	const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced !== null) body = fenced[1].trim();
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(body.slice(start, end + 1));
		return parsed !== null && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Pull a JSON array out of a model reply, fenced or bare.
 * @param text - the model output.
 * @returns the parsed array, or null.
 */
function parseJsonArrayLoose(text) {
	if (typeof text !== "string") return null;
	let body = text.trim();
	const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced !== null) body = fenced[1].trim();
	const start = body.indexOf("[");
	const end = body.lastIndexOf("]");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(body.slice(start, end + 1));
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Mount the host half.
 * @param ctx - the host context.
 * @param config - `{ enabled, level, strictness, autoAdapt }` from the cordis row.
 */
export function apply(ctx, config = {}) {
	const defaults = {
		level: guide.normalizeLevel(config.level),
		strictness: guide.clampInt(config.strictness, guide.STRICTNESS_MIN, guide.STRICTNESS_MAX, 50),
		// Off unless asked for. The memory file, once it records a switch value,
		// wins over this default.
		enabled: config.enabled === true
	};
	const cache = { mtimeMs: -1, value: null };
	/** Read the defaults the memory falls back to. */
	const read = () => defaults;
	/** Whether the guide is switched on right now. */
	const isEnabled = () => readMemory(cache, defaults).enabled === true;
	// The prompt text is cached per step; a toggle must invalidate it at once.
	const promptCache = { text: "", builtAt: 0 };

	/** Persist a change and return the new state. */
	const commit = (mutate) => {
		const memory = readMemory(cache, defaults);
		const next = mutate(memory);
		writeMemory(next);
		cache.value = next;
		cache.mtimeMs = Date.now();
		return stateOf(next);
	};

	// ---- model-facing tool ----
	// `when` is evaluated once per model step, so a switched-off guide does not
	// even ship the tool schema: the biggest per-turn cost disappears with the
	// switch, not only the prompt rules.
	ctx.tools.register(
		defineTool({
			name: "explain_terms",
			description:
				"Record professional terms from your answer that the user may not understand, with a one-sentence explanation and a from-basics exploration path. " +
				"Call it only when a term is domain-specific, above the user's level, and relevant to their current goal. " +
				"When the user says they want to enter or study a field, explain that field's key acronym even if it looks familiar; abbreviations default to being explained. " +
				"At most 4 terms per call; skip the call entirely when nothing needs explaining.",
			parameters: {
				terms: {
					type: "array",
					required: true,
					description: "Terms to explain. At most 4.",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							term: { type: "string", required: true, description: "The exact term as written in the answer." },
							explanation: { type: "string", required: true, description: "One plain-language sentence, at most 60 characters." },
							category: { type: "string", description: "Short domain label, e.g. 机器学习 / 分布式系统 / 法律." },
							parent: {
								type: "string",
								description: "The already-recorded term this one derives from, spelled exactly. Omit when it is a new root."
							},
							related: {
								type: "array",
								description: "Adjacent or sibling terms already recorded, for cross links.",
								items: { type: "string" }
							},
							confidence: { type: "number", description: "0–1: how likely the user does not know this term." },
							tree: {
								type: "array",
								description: "Exploration path from basic concepts to this term, shallow-to-deep.",
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										label: { type: "string", required: true, description: "A concept on the path." },
										note: { type: "string", description: "One line on why this step matters." },
										children: { type: "array", description: "Optional finer steps below this one.", items: { type: "object", additionalProperties: true } }
									}
								}
							},
							links: {
								type: "array",
								description: "Optional authoritative links. Search links are added automatically.",
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										label: { type: "string", required: true },
										url: { type: "string", required: true }
									}
								}
							}
						}
					}
				},
				reason: { type: "string", description: "One short line: why these terms need explaining now." },
				strictnessAdjust: { type: "number", description: "−20…+20. Raise when the user keeps asking about the same concept." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						saved: { type: "number" },
						total: { type: "number" },
						level: { type: "string" },
						strictness: { type: "number" },
						terms: { type: "array", items: { type: "string" } },
						updatedAt: { type: "string" }
					}
				},
				render: (_args, value) => [
					{
						type: "text",
						text:
							value.saved === 0
								? "没有可记录的术语。"
								: `已记录 ${value.saved} 个术语：${value.terms.join("、")}（严格度 ${value.strictness}/100，共 ${value.total} 个词条）`
					}
				]
			},
			async execute(args) {
				// The tool is hidden while switched off, but a call prepared
				// before the toggle can still land: record nothing then.
				const records = isEnabled() ? guide.normalizeTerms(args) : [];
				if (records.length === 0) {
					const memory = readMemory(cache, defaults);
					return { saved: 0, total: memory.terms.length, level: memory.level, strictness: memory.strictness, terms: [], updatedAt: memory.updatedAt };
				}
				const memory = readMemory(cache, defaults);
				const next = guide.mergeTerms(memory, records, {
					now: new Date(),
					level: memory.level,
					strictnessAdjust: args.strictnessAdjust,
					reason: args.reason
				});
				writeMemory(next);
				cache.value = next;
				cache.mtimeMs = Date.now();
				return {
					saved: records.length,
					total: next.terms.length,
					level: next.level,
					strictness: next.strictness,
					terms: records.map((record) => record.term),
					updatedAt: next.updatedAt
				};
			}
		}),
		{
			// Step-time activation: false keeps the tool out of the model's schema
			// set entirely, so "off" also means zero tokens spent on it.
			when: () => isEnabled()
		}
	);

	contributePrompt(ctx, read, cache, isEnabled, promptCache);

	// ---- HTTP surface for the panel ----
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: ROUTE_PREFIX,
				handler: async (req, res) => {
					const path = new URL(req.url ?? "/", "http://dsh.invalid").pathname.slice(ROUTE_PREFIX.length) || "/";
					try {
						if (path === "/state" || path === "/") {
							if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
							return sendJson(res, 200, stateOf(readMemory(cache, defaults)));
						}
						if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
						const body = await readJson(req);
						if (body === null) return sendJson(res, 400, { error: "a JSON object body is required" });

						if (path === "/level") {
							const level = guide.normalizeLevel(body.level);
							return sendJson(res, 200, commit((memory) => ({ ...memory, level, updatedAt: new Date().toISOString() })));
						}
						if (path === "/strictness") {
							const strictness = guide.clampInt(body.value, guide.STRICTNESS_MIN, guide.STRICTNESS_MAX, 50);
							return sendJson(res, 200, commit((memory) => ({ ...memory, strictness, updatedAt: new Date().toISOString() })));
						}
						if (path === "/enabled") {
							// The master switch. Accept both spellings so the client can send
							// either `{ enabled }` or `{ value }` without a silent no-op.
							const enabled = guide.normalizeEnabled(typeof body.enabled === "boolean" ? body.enabled : body.value);
							const state = commit((memory) => ({ ...memory, enabled, updatedAt: new Date().toISOString() }));
							// The prompt text is cached for a few seconds; drop it now, or
							// the very next turn would still carry the old rules.
							promptCache.text = "";
							promptCache.builtAt = 0;
							if (!enabled) {
								// Queued scans must not write terms for a guide the user
								// just switched off.
								for (const timer of supplement.timers.values()) clearTimeout(timer);
								supplement.timers.clear();
							}
							return sendJson(res, 200, state);
						}
						if (path === "/forget") {
							const term = guide.cleanText(body.term, 60);
							if (term === "") return sendJson(res, 400, { error: "term is required" });
							return sendJson(
								res,
								200,
								commit((memory) => ({
									...memory,
									terms: memory.terms.filter((item) => item.term !== term),
									updatedAt: new Date().toISOString()
								}))
							);
						}
						if (path === "/clear") {
							return sendJson(res, 200, commit((memory) => ({ ...memory, terms: [], updatedAt: new Date().toISOString() })));
						}
						return sendJson(res, 404, { error: "not found" });
					} catch (error) {
						sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			}),
		`learning-assistant: routes under ${ROUTE_PREFIX}`
	);

	// ---- supplemental explanations -------------------------------------------
	// The model answers however it likes. After the answer settles, this scans
	// the text for professional acronyms it did NOT explain and writes the
	// explanation itself, so the sidebar never depends on the model remembering
	// to call a tool.
	let llm = null;
	let defaultModel = null;
	ctx.inject(["llm", "agentDefaultModel"], (serviceCtx) => {
		llm = serviceCtx.llm ?? null;
		defaultModel = serviceCtx.agentDefaultModel ?? null;
		ctx.effect(
			() => () => {
				llm = null;
				defaultModel = null;
			},
			"learning-assistant: supplement services detached"
		);
	});

	const supplement = { inFlight: false, lastRun: 0, timers: new Map(), pending: new Map(), questions: new Map() };

	/**
	 * Pick the route the agent itself is using, then any provider that has models.
	 * @returns `{ provider, model }`, or null when nothing is mounted.
	 */
	async function resolveTarget() {
		try {
			const current = typeof defaultModel?.currentSelection === "function" ? defaultModel.currentSelection() : null;
			if (current !== null && typeof current.provider === "string" && typeof current.model === "string") {
				return { provider: current.provider, model: current.model };
			}
		} catch (error) {
			void error;
		}
		if (llm === null) return null;
		try {
			const providers = typeof llm.listProviders === "function" ? llm.listProviders() : [];
			for (const provider of providers) {
				const id = provider?.provider ?? provider?.id ?? provider?.name;
				if (typeof id !== "string" || id === "") continue;
				const models = await llm.listModels(id);
				const model = Array.isArray(models) && models.length > 0 ? models[0].model ?? models[0].id : null;
				if (typeof model === "string" && model !== "") return { provider: id, model };
			}
		} catch (error) {
			console.error("[learning-assistant] model route resolution failed:", error);
		}
		return null;
	}

	/**
	 * Scan one finished answer and store what it did not explain.
	 * @param text - the answer text.
	 */
	async function runSupplement(text, question) {
		// Switched off: no scan, no extra model call, no writes. The check sits
		// first because the timer may fire after the user flipped the switch.
		if (!isEnabled()) return;
		if (supplement.inFlight) return;
		if (Date.now() - supplement.lastRun < SUPPLEMENT_COOLDOWN_MS) return;
		if (llm === null || typeof text !== "string" || text.length < 40) return;

		const memory = readMemory(cache, defaults);
		const limit = memory.strictness >= 70 ? 3 : memory.strictness <= 30 ? 1 : 2;

		supplement.inFlight = true;
		try {
			// Let the model pick the terms it left unexplained, instead of a
			// brittle acronym regex. This catches ViT, CLIP, Transformer, LeRobot,
			// and CJK terms alike — anything a reader at `memory.level` could miss.
			const records = await pickUnexplainedTerms(text, question, memory, limit);
			for (const record of records) {
				// The switch can be flipped while the picking call is in flight.
				if (!isEnabled()) break;
				const next = guide.mergeTerms(readMemory(cache, defaults), [{ ...record, source: "supplement" }], {
					now: new Date(),
					level: readMemory(cache, defaults).level,
					strictnessAdjust: 0,
					reason: `自动补充：正文未解释 ${record.term}`
				});
				writeMemory(next);
				cache.value = next;
				cache.mtimeMs = Date.now();
			}
		} catch (error) {
			console.error("[learning-assistant] supplement pass failed:", error);
		} finally {
			supplement.inFlight = false;
			supplement.lastRun = Date.now();
		}
	}

	/**
	 * Ask the model which terms in one answer it left unexplained, and return
	 * fully-formed records for up to `limit` of them.
	 * @param text - the answer.
	 * @param question - the user's last question (for disambiguation).
	 * @param memory - current memory (level + known names).
	 * @param limit - how many terms to explain at most.
	 * @returns normalized term records (empty when nothing needs explaining).
	 */
	async function pickUnexplainedTerms(text, question, memory, limit) {
		if (llm === null) return [];
		const target = await resolveTarget();
		if (target === null) return [];
		const known = memory.terms.map((item) => item.term).slice(0, 40).join("、");
		const prompt = [
			"下面是 AI 的一段回答。请从中挑出「用户（水平：" + guide.LEVEL_LABELS[memory.level] + "）可能不理解的、且这段回答本身没有解释清楚的专业术语」。",
			"标准：该领域的专有名词或缩写（如 ViT、CLIP、Transformer、LeRobot、注意力机制、量化……），不是普通词。",
			"已收录、本次不要再列：" + (known === "" ? "（无）" : known) + "。",
			question === "" ? "" : "用户的原问题（用于消歧）：" + question.slice(0, 300),
			"",
			"回答原文：",
			String(text).slice(0, 4000),
			"",
			"只输出 JSON 数组，每个元素是一个术语对象：",
			'[{ "term":"术语", "explanation":"≤60字说人话解释", "category":"领域标签",',
			'   "tree":[{"label":"最基础概念","note":"一句话"},{"label":"中间概念","note":"..."},{"label":"该术语","note":"..."}],',
			'   "parent":"（可选）已收录词中它隶属的那个，没有就省略",',
			'   "links":[{"label":"权威来源","url":"https://..."}] }]',
			"最多 " + limit + " 个；如果一段话里没有需要解释的专业术语，就输出 []。只输出 JSON。"
		].join("\n");

		const controller = typeof AbortController === "function" ? new AbortController() : null;
		const timer = controller === null ? null : setTimeout(() => controller.abort(), SUPPLEMENT_TIMEOUT_MS);
		try {
			const stream = llm.stream({
				provider: target.provider,
				model: target.model,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
				system: SUPPLEMENT_SYSTEM,
				temperature: 0.2,
				maxTokens: 1200,
				...(controller === null ? {} : { signal: controller.signal })
			});
			let textOut = "";
			for await (const chunk of stream) {
				if (chunk !== null && typeof chunk === "object" && chunk.type === "text-delta" && typeof chunk.text === "string") textOut += chunk.text;
			}
			const parsed = parseJsonArrayLoose(textOut);
			if (!Array.isArray(parsed)) return [];
			const records = guide.normalizeTerms({ terms: parsed });
			return records.slice(0, limit);
		} catch (error) {
			console.error("[learning-assistant] term picking failed:", error instanceof Error ? error.message : error);
			return [];
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}

	/** Coalesce the assistant messages of one turn, then scan the whole answer. */
	ctx.on("session/event", (session, event) => {
		if (event === null || typeof event !== "object") return;
		const sessionKey = String(session?.id ?? session?.sessionId ?? "session");

		// The last question disambiguates one acronym from another: `VLA` is a C
		// feature in a C thread and a robotics model elsewhere.
		if (event.type === "user/message") {
			const parts = Array.isArray(event.data?.content) ? event.data.content : [];
			const asked = parts
				.filter((part) => part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join(" ")
				.trim();
			if (asked !== "") supplement.questions.set(sessionKey, asked);
			return;
		}
		if (event.type !== "assistant/message") return;
		const content = event.data?.message?.content;
		if (!Array.isArray(content)) return;
		const text = content
			.filter((part) => part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
		if (text.trim() === "") return;
		// Switched off: nothing is collected, so no timer is armed at all.
		if (!isEnabled()) return;

		const key = sessionKey;
		supplement.pending.set(key, `${supplement.pending.get(key) ?? ""}\n${text}`);
		const existing = supplement.timers.get(key);
		if (existing !== undefined) clearTimeout(existing);
		supplement.timers.set(
			key,
			setTimeout(() => {
				supplement.timers.delete(key);
				const buffered = supplement.pending.get(key) ?? "";
				supplement.pending.delete(key);
				void runSupplement(buffered, supplement.questions.get(key) ?? "");
			}, SUPPLEMENT_DEBOUNCE_MS)
		);
	});

	ctx.effect(
		() => () => {
			for (const timer of supplement.timers.values()) clearTimeout(timer);
			supplement.timers.clear();
			supplement.pending.clear();
			supplement.questions.clear();
		},
		"learning-assistant: supplement timers cleared"
	);
}
