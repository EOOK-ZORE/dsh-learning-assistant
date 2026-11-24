# dsh-learning-assistant · 学习助手

> 模型照常回答，插件补它没解释的**专业术语**：自动记进记忆、按对话过滤展示，右侧栏知识树 + 正文高亮 + 一句话解释与学习路径。越用越懂你已经会了什么。
>
> **默认关闭**，需要时在面板里一键打开——不开的时候，它不占系统提示、不发工具 schema、不额外调模型。

## 总开关

插件入口在对话标题栏：**「术语」按钮**。点开右侧栏面板，顶部就是这个开关。

| 状态 | 行为 |
|---|---|
| **开**（面板显示「已开启」） | 系统提示里带判定规则；`explain_terms` 工具对模型可见；回答结束后自动补录未解释的词；正文里的词加淡蓝标记 |
| **关**（默认，面板显示「已关闭」） | 不注入提示、不发工具 schema、不自动补词、正文不高亮；**已有词条、水平与严格度全部保留**，随时可再打开 |

- 状态写在 `$DSH_HOME/dsh-learning-assistant/terms.json` 的 `enabled` 字段，重启后保持。
- 关闭时标题栏按钮会变虚并显示一个小「关」标记，避免误以为是插件坏了。
- 想让它装好就默认开着：把 `cordis.patch.yml` 里的 `enabled` 改成 `true`（仅当记忆文件还没有开关记录时生效）。

关闭的代价是零：`explain_terms` 用 `ctx.tools.register(definition, { when })` 做条件激活，关掉时整个工具从模型可见的 schema 集合里消失；系统提示段返回空文本，组装器会把空段丢弃。

## 它做了什么

1. **判断**：Host 半往系统提示里注入一段规则——结合「你的水平档位」「解释倾向严格度」「记忆里你已经见过的词」，判断本次回答里哪些词值得解释。没有需要解释的词就不调用。
2. **记录**：模型调用 `explain_terms` 工具，Host 把词条写入 `$DSH_HOME/dsh-learning-assistant/terms.json`。重复出现的词会累加 `count`（这是"你可能已经学会了"的证据）。
3. **呈现**：标题栏常驻「术语 N」按钮（N = 全局词条数），点它打开右侧栏标签页。面板默认**只列本对话涉及的词**（记忆本身是全局的，跨对话不会重复解释），顶部可切「本对话 / 全部」。面板有「词条 / 知识树」两个视图：
   - **词条**：每个词一张卡片——解释、缩进学习路径、隶属/延伸跳转、维基/Google/Bing 外链；
   - **知识树**：按「隶属 → 延伸」组织的层级视图，节点显示分类与「延伸 N」，点击任一节点回到词条视图并定位。
4. **正文高亮**：已在侧栏有词条的术语，在对话正文里自动标记（淡蓝底 + 虚线下划线）。纯视觉层——没有悬浮气泡；**点击标记**会打开右侧栏并**自动滚动到该词卡片**（卡片同时脉冲两次）。
5. **自动呈现**：新词入库时，右侧栏会**自己展开**并切到「术语」标签（首次加载不会抢视图，只有词条集合真的增长时才开）。
6. **反向定位**：**双击侧栏卡片**，正文里该词的**所有出现位置一起闪烁三次**（琥珀色），若不在视口内先把第一处滚到中间。
7. **自适应**：用户连续追问同一个概念时，模型会把 `strictnessAdjust` 设为 +10，以后更倾向于解释。

## 架构

```
lib/index.js         Host 半（ESM）
  ├─ 总开关                    terms.json 的 enabled，默认关
  ├─ explain_terms 工具       ctx.tools.register(defineTool(...), { when })
  ├─ 系统提示段落             ctx.systemPrompt.section(...)（关闭时返回空串）
  ├─ HTTP 路由 /learning-assistant/*  ctx.webServer.register({kind:'prefix'})
  └─ 记忆文件                 $DSH_HOME/dsh-learning-assistant/terms.json

lib/client.js        Client 半（构建产物，window.__ModuleLoader__ 格式）
  ├─ 常驻入口        ctx.slots.register('conversation.session.header.actions') → 「术语 N」按钮 + 开关状态
  ├─ 标签类型        ctx.sidebarRightTabs.register({ id, kind, title })
  ├─ 标签主体        ctx.slots.register({ name: 'sidebar.right.pane.tab', key })
  ├─ 打开            ctx.sidebarRight.openTab(kind)（自动展开右栏）
  └─ 轮询 /learning-assistant/state（5s + 窗口聚焦，在 apply 里跑）

lib/core/guide.js    两端共享的纯逻辑（归一化 / 合并 / 开关归一化 / 外链模板）
lib/core/highlight.js  正文高亮：CSS Custom Highlight + 点击命中（关闭时词集为空）
lib/core/shell.js    Client 源码（React.createElement，无 JSX）
tools/build-client.mjs   把 core/*.js 内联进 lib/client.template.js → lib/client.js
tools/selfcheck.mjs      两端功能自检（60 项，含总开关）
tools/preview-panel.mjs  用真实 bundle 渲染面板 HTML 预览（调样式时不用重启 dsh）
tools/deploy.ps1         Windows：构建 + 同步进 DSH profile（绕过 link 的解析问题）
tools/probe-*.mjs        无头浏览器探针（滚动/几何/交互/知识树/自动展开/准确率）
```

## 配置（`cordis.patch.yml` 的 config）

| 字段 | 含义 | 默认 |
|---|---|---|
| `enabled` | 起始开关；记忆文件已有开关记录时以文件为准 | `false` |
| `level` | `beginner` / `intermediate` / `expert`，判定基准 | `intermediate` |
| `strictness` | 0–100，越高越爱解释；面板里的滑杆改的是同一个值 | `50` |
| `autoAdapt` | 预留给模型的自适应开关 | `true` |

面板里的「我的水平」「解释倾向」改动会写回记忆文件，优先级高于 config 默认值。

## HTTP 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/learning-assistant/state` | 读取词条 / 水平 / 严格度 / 开关 |
| POST | `/learning-assistant/enabled` | `{ enabled: true \| false }`（也接受 `{ value }`） |
| POST | `/learning-assistant/level` | `{ level }` |
| POST | `/learning-assistant/strictness` | `{ value }` |
| POST | `/learning-assistant/forget` | `{ term }` 移除一个词条 |
| POST | `/learning-assistant/clear` | 清空词条（不动开关） |

## 数据模型

`terms.json` 的顶层字段：`level`、`strictness`、`enabled`、`updatedAt`、`terms`、`signals`。

每个词条除 `term` / `explanation` / `tree` / `links` / `count` 外，还可能有：

| 字段 | 含义 |
|---|---|
| `parent` | 它从哪个已收录词延伸出来（知识树的上级）。缺失或指向未收录词时，该词作为根节点，并标注「隶属 X（未收录）」 |
| `related` | 同层或强相关词的名称，卡片上以 `↔` 芯片展示 |

模型在 `explain_terms` 里填写这两个字段；Host 归一化时剔除自引用与空值。树的构建（`guide.buildKnowledgeTree`）对环、缺失父级、重复挂载都做了保护，最多 9 层。写词条不会改动 `enabled`。

## 安装

dsh 的「设置 → 插件 → 添加插件」接受三种输入：**npm 包名**、**GitHub 仓库地址**、**本地目录路径**。本包三种都支持，其中本地目录路径**无需发布**即可安装。

```bash
# 本地目录（未发布时用这个）
dsh plugin --profile web add /绝对路径/dsh-learning-assistant

# npm 包名（发布之后）
dsh plugin --profile web add dsh-learning-assistant

# GitHub 仓库
dsh plugin --profile web add https://github.com/EOOK-ZORE/dsh-learning-assistant
```

这条命令会做三件事：把包写进 profile 的 `dependencies`、把它加进 `dsh.profile.bundles`、并让 pnpm 建立 `node_modules` 链接。**装完即生效，启动时不需要 `--patch`**。

> 前提：`pnpm` 必须在 dsh 进程的 PATH 里（插件管理器用 `pnpm add` 安装）。
> dsh 从 **profile 目录**解析裸包名（`~/.dsh/profiles/<profile>/`），不是从安装 dsh 的目录。

手动软链（只调试、不走管理器）：

```bash
mkdir -p ~/.dsh/profiles/web/node_modules
ln -sfn /绝对路径/dsh-learning-assistant ~/.dsh/profiles/web/node_modules/dsh-learning-assistant
```

此时 profile 里没有 bundle 记录，启动要显式带 patch：

```bash
dsh web --patch /绝对路径/dsh-learning-assistant/cordis.patch.yml --no-open --port 3080
```

`--patch` 后面跟路径时，会把这个 overlay 叠在 profile 之上；`cordis.patch.yml` 里只有一行：插入 `learning-assistant` 这个 Host 半。Client 半不需要单独一行——`package.json` 的 `dsh.client` 声明会让客户端模块系统自动加载 `exports["./client"]`。

## 本地开发与部署（Windows）

宿主提供的 `@deepseek-ai/*` 包在 dsh 安装目录里，不在本仓库。Windows 上 pnpm 的 `link:` 会建 junction，Node 解析 `import "@deepseek-ai/dsh-tools"` 时会 realpath 回源码目录，那里找不到宿主包，插件 fiber 不激活（界面没有按钮，`/learning-assistant/*` 全 404）。

所以改完代码后**复制**进 profile，而不是链接：

```powershell
pwsh -File tools\deploy.ps1
```

它会 `node tools/build-client.mjs`，把源码同步到 `~/.dsh/profiles/desktop/node_modules/dsh-learning-assistant`（排除 `.git` / `node_modules`），再校验关键文件存在且不是链接。之后重启 DeepSeek Harness 生效。

## 构建与自检

```bash
node tools/build-client.mjs          # 生成 lib/client.js
node tools/build-client.mjs --check  # CI：校验产物是否最新
node tools/selfcheck.mjs             # 两端 60 项断言，零依赖
node tools/preview-panel.mjs         # 渲染 preview/panel.html：开启/关闭两种状态并排
npm run verify                       # check + test（prepack 会自动跑）
```

只依赖 `react` 一个平台 seed；没有 CSS 文件、没有 JSX，因此不需要打包器。
自检里的 Host 断言会临时造一个 `@deepseek-ai/dsh-tools` 桩（真实包在桌面应用内，裸 checkout 解析不到），因此不需要先安装宿主依赖。

`tools/probe-*.mjs` 是无头浏览器探针（滚动/几何/交互/知识树/自动展开），需要 `playwright-core` 可被解析，不随包发布。

## 打包与发布

```bash
npm run verify     # 产物校验 + 全量断言，失败则打包中止
npm pack           # 产出 tarball
npm publish        # publishConfig 已指向 registry.npmjs.org
```

所有工具脚本的路径都从自身位置解析（`import.meta.url`），不写死绝对路径。
`files` 是白名单，`tools/`（构建与探针）不进包。

## 已知限制

- 状态每 5 秒轮询一次，不是推送；本地文件很小，开销可忽略。轮询在 `apply` 里跑，与面板是否打开无关——否则面板和高亮都会一直空着。
- 关闭开关后，**已经在飞的那次补充调用**可能仍返回；Host 在写盘前再查一次开关，不会再落新词。
- 面板是**右侧栏标签页**，不是中间主区域：`main` 插槽会整块替换对话，所以不使用它。
- 入口是**对话头部按钮**而非右栏标签本身：右栏未展开时标签不可见，没有词条时更不会自动弹出。
- 右栏展开会压缩对话宽度；折叠/展开用对话头部右侧的侧栏开关，或点标签条上的关闭。
- 正文高亮只标记**已在记忆里的词**，且只扫 `[data-conversation-scroll]` 内的散文节点，跳过 `code/pre/textarea` 与插件自身 UI；浏览器不支持 CSS Custom Highlight API 时自动降级为「只有面板，无正文标记」。
- 观察器挂在 `document.body` 上而不是滚动容器：切换会话会替换容器，挂旧节点会静默失效。
- 自动打开只在「词条集合增长」时触发，且开关为开；首次加载只填充不抢视图。
- 未做「选中一段文字→一键解释」的手势面（`conversation.chat.text-interaction` 槽位可用，后续可加）。
- 外链优先开在右栏的 `browser` 标签；本部署没有注册 browser 类型时回退 `window.open`，被拦截则复制链接并在面板提示。
- 判定质量取决于模型；严格度与水平档位是最有效的两个调节旋钮。
