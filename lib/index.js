/**
 * Host half of the term guide.
 *
 * It owns three things the page cannot own by itself:
 *  1. the durable memory file, under `$DSH_HOME/dsh-plugin-term-guide/`;
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
export const name = "term-guide";

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
const ROUTE_PREFIX = "/term-guide";

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
	return join(home, "dsh-plugin-term-guide", "terms.json");
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
			if (cache.value === null) cache.value = guide.emptyMemory(defaults.level, defaults.strictness);
			return cache.value;
		}
		const stat = require("node:fs").statSync(path);
		if (stat.mtimeMs !== cache.mtimeMs || cache.value === null) {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			cache.value = {
				...guide.emptyMemory(defaults.level, defaults.strictness),
				...parsed,
				terms: Array.isArray(parsed.terms) ? parsed.terms : []
			};
			cache.mtimeMs = stat.mtimeMs;
		}
		return cache.value;
	} catch (error) {
		console.error("[term-guide] memory read failed:", error);
		if (cache.value === null) cache.value = guide.emptyMemory(defaults.level, defaults.strictness);
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
 * @param ctx - the host context.
 * @param read - reads the current config defaults.
 * @param cache - the memory cache holder.
 */
function contributePrompt(ctx, read, cache) {
	ctx.inject(["systemPrompt"], (promptCtx) => {
		promptCtx.effect(
			() =>
				promptCtx.systemPrompt.section({
					name: "term-guide",
					order: SECTION_ORDER,
					text: () => {
						const memory = readMemory(cache, read());
						const known = guide.summarizeMemory(memory);
						return [
							"## 术语向导（term-guide）",
							"在给出回答后，你需要判断：本次回答里出现的专业术语，用户是否可能听不明白。判断依据是：",
							`- 用户水平：${guide.LEVEL_LABELS[memory.level] ?? memory.level}。`,
							`- 解释倾向（严格度）：${memory.strictness}/100，越高越应当倾向于解释。`,
							known === "" ? "- 记忆：暂无已知术语。" : `- 记忆（用户已见过的词，带数字表示重复次数）：${known}。`,
							"规则：",
							"1. 只有「该领域专业词」且「高于用户水平」且「与用户当前问题或研究方向相关」时，才调用 explain_terms 工具；日常词、代码通用词不要解释。",
							"2. 每次最多 4 个词；没有需要解释的词就完全不调用，不要为了用工具而调用。",
							"3. 每个词给出：一句话解释（≤60 字，说人话，不用同义术语循环定义）；一条「学习路径」树（3–6 个节点，由最基础的概念逐层推进到该词，可带 1 层 children）；可选 1–2 个权威外链（模型不需要自己拼搜索链接，系统会自动补）。",
							"4. 若用户连续追问同一个词，说明其理解不足：更深入地解释，并在调用时把 strictnessAdjust 设为 +10 左右。",
							"5. 「已掌握」的证据只有三种：用户用自己的话解释过该词、纠正过你、或该词在记忆里 count≥3 且此后没再追问。**仅仅提到一个词、或说想从事/学习这个方向，都不算掌握**。",
							"6. **不要为了配合工具改变回答方式**：该展开就正常展开。正文里已经解释过的词，可以顺手写进 explain_terms；没写也没关系，插件会自动补齐正文里没解释的词。",
							"7. 隶属关系：若本次的词是从记忆里已有的某个词延伸出来的（例：优先级反转 隶属 抢占式优先级调度；RTOS 隶属 实时系统），把 parent 填成那个词的**准确名称**；没有明确隶属就留空，不要硬凑。related 填同层或强相关的已收录词，用准确名称。",
							"8. **意向即信号**：用户说「我想从事/学习/转行到 X」「X 行业怎么样」「怎么入门 X」时，X 本身**必须**解释——这类表述说明 X 是用户要投入的方向，而不是他已知的证明；同时给出 X 的上位概念与入门路径。",
							"9. **缩写默认解释**：本轮问题里出现的专业缩写（如 VLA、RLHF、MCP、TLM），即使你猜用户可能听过，也默认解释——缩写的理解门槛高于普通词。",
							"10. 拿不准时偏向解释：漏掉一个关键概念的代价，高于多解释一个已知词的代价。",
							"11. 顺序随意：写正文前后调用都可以；不调用也不会漏——宿主会在回答结束后自动扫描正文、补齐未解释的专业词。"
						].join("\n");
					}
				}),
			"term-guide: system prompt section"
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
 * Mount the host half.
 * @param ctx - the host context.
 * @param config - `{ level, strictness, autoAdapt }` from the cordis row.
 */
export function apply(ctx, config = {}) {
	const defaults = {
		level: guide.normalizeLevel(config.level),
		strictness: guide.clampInt(config.strictness, guide.STRICTNESS_MIN, guide.STRICTNESS_MAX, 50)
	};
	const cache = { mtimeMs: -1, value: null };
	/** Read the defaults the memory falls back to. */
	const read = () => defaults;

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
				const records = guide.normalizeTerms(args);
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
		})
	);

	contributePrompt(ctx, read, cache);

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
		`term-guide: routes under ${ROUTE_PREFIX}`
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
			"term-guide: supplement services detached"
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
			console.error("[term-guide] model route resolution failed:", error);
		}
		return null;
	}

	/**
	 * One model call that returns a JSON term record.
	 * @param term - the acronym to explain.
	 * @param context - the answer it appeared in.
	 * @param memory - current memory (level + known names for `parent`).
	 * @returns a normalized record, or null.
	 */
	async function explainWithModel(term, context, memory, question) {
		if (llm === null) return null;
		const target = await resolveTarget();
		if (target === null) return null;
		const known = memory.terms.map((item) => item.term).slice(0, 30).join("、");
		const prompt = [
			`术语：${term}`,
			question === "" ? "" : `用户的原问题：${question.slice(0, 400)}`,
			`用户水平：${guide.LEVEL_LABELS[memory.level] ?? memory.level}`,
			known === "" ? "已收录词：无" : `已收录词（可从中选 parent）：${known}`,
			"",
			"以下是它出现的回答片段（只用于理解语境，不要复述）：",
			String(context).slice(0, 2500),
			"",
			"输出一个 JSON 对象，字段：",
			'{ "term": "原词", "explanation": "一句话解释，≤60字，说人话，不要用同义词循环定义", "category": "领域标签",',
			'  "tree": [{"label":"最基础的概念","note":"一句话说明"},{"label":"中间概念","note":"..."},{"label":"原词","note":"..."}],',
			'  "parent": "（可选）已收录词中它隶属的那个，没有就省略",',
			'  "links": [{"label":"权威来源","url":"https://..."}] }',
			"tree 用 3–5 个节点，从最基础推进到该词；links 最多 2 条，给真实可访问的地址。",
			"如果它不是「值得解释的专业术语」（代码标识符、语言标准编号、变量名、与问题无关的噪音），",
			"就只输出 {\"skip\": true}。同一缩写有多义时，按「用户的原问题」判断义项。只输出 JSON。"
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
				maxTokens: 700,
				...(controller === null ? {} : { signal: controller.signal })
			});
			let text = "";
			for await (const chunk of stream) {
				if (chunk !== null && typeof chunk === "object" && chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
			}
			const parsed = parseJsonLoose(text);
			if (parsed === null) return null;
			if (parsed.skip === true) return null;
			const records = guide.normalizeTerms({ terms: [{ ...parsed, term: parsed.term ?? term }] });
			return records[0] ?? null;
		} catch (error) {
			console.error("[term-guide] supplemental explanation failed:", error instanceof Error ? error.message : error);
			return null;
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}

	/**
	 * Scan one finished answer and store what it did not explain.
	 * @param text - the answer text.
	 */
	async function runSupplement(text, question) {
		if (supplement.inFlight) return;
		if (Date.now() - supplement.lastRun < SUPPLEMENT_COOLDOWN_MS) return;
		if (llm === null || typeof text !== "string" || text.length < 40) return;

		const memory = readMemory(cache, defaults);
		const limit = memory.strictness >= 70 ? 3 : memory.strictness <= 30 ? 1 : 2;
		const candidates = guide.extractCandidates(text, memory.terms.map((item) => item.term), limit);
		if (candidates.length === 0) return;

		supplement.inFlight = true;
		try {
			for (const term of candidates) {
				const record = await explainWithModel(term, text, readMemory(cache, defaults), question);
				if (record === null) continue;
				const next = guide.mergeTerms(readMemory(cache, defaults), [{ ...record, source: "supplement" }], {
					now: new Date(),
					level: readMemory(cache, defaults).level,
					strictnessAdjust: 0,
					reason: `自动补充：正文未解释 ${term}`
				});
				writeMemory(next);
				cache.value = next;
				cache.mtimeMs = Date.now();
			}
		} catch (error) {
			console.error("[term-guide] supplement pass failed:", error);
		} finally {
			supplement.inFlight = false;
			supplement.lastRun = Date.now();
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
		"term-guide: supplement timers cleared"
	);
}
