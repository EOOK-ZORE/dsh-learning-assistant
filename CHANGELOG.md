# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-11-24

### Added
- **总开关**：插件现在默认**关闭**，需要时再打开。关闭时不注入系统提示、不自动补充
  新词、正文不高亮、也不把 `explain_terms` 的 schema 发给模型——每一轮的固定开销
  归零；已收录的词条和你的水平/严格度设置都保留。
- 开关状态存在 `terms.json` 的 `enabled` 字段里，重启后保持；面板顶部是带说明的开关，
  对话标题栏的「术语」按钮会显示「关」并变虚，一眼能看出是关掉了而不是坏了。
- `POST /learning-assistant/enabled` 路由；`GET /state` 返回值新增 `enabled`。
- 新增 config 字段 `enabled`（默认 `false`），只在记忆文件还没有开关记录时生效。
- 关闭态的空面板给出「开启术语向导」按钮，不用去翻开关。

### Changed
- `explain_terms` 改为条件激活（`tools.register(definition, { when })`）：关闭时整个
  工具从模型可见列表里消失，而不只是不提示它调用。
- 关闭时系统提示段返回空文本（组装器会丢弃空段），因此开关不需要重建注册。
- 自检扩到 60 项，覆盖默认关闭、开启/关闭往返、提示与工具随开关变化、开关不被写词条
  覆盖、面板与头部入口的两种状态；宿主包不在仓库里时用临时桩跑 Host 断言。

## [0.3.2] — 2026-11-23

### Changed
- 自动补充的选词改由模型判断，不再依赖缩写正则，能覆盖 ViT、CLIP、Transformer、
  LeRobot 以及中文术语；严格度只决定每次最多补几个。

## [0.2.1] — 2026-11-14

### Added
- 面板默认**只显示本对话涉及的词**：记忆仍是全局的（跨对话不重复解释），但展示按当前对话过滤。
  顶部「本对话 N / 全部 M」可一键切到全部记忆。
- 纯函数 `guide.filterTermsForText()`（大小写不敏感；空对话返回空；拿不到对话容器时退回全部）。
- 对话标题栏常驻「术语 N」按钮，作为与内容状态无关的入口。

### Fixed
- 无词条时插件不可达：只注册右侧栏标签时，右栏未展开就没有入口。

## [0.2.0] — 2026-11-14

### Changed
- **判定改为「事后补充」**：不再要求模型必须调用工具，模型照常回答即可。
  回答结束后，Host 扫描正文里出现、但记忆尚未收录的专业缩写，自己调用一次
  模型生成解释、学习路径和隶属关系，写入记忆。
- 系统提示相应放宽：明确告诉模型「不要为了配合工具改变回答方式」。
- 术语数量上限与提示/ schema 对齐（4）。

### Added
- 确定性候选抽取 `guide.extractCandidates()`：三字母以上、带字母边界、
  内置通用缩写停用表（AI/API/CPU/LLM…），按出现频次排序。
- 补充解释带上「用户的原问题」做消歧（`VLA` 在 C 话题与机器人话题下取义不同）。
- 模型可用 `{"skip": true}` 拒绝非术语候选（语言标准编号、代码标识符等）。
- 卡片上以「自动补充」标签区分模型主动记录与插件补齐的词条。
- 包结构规范化：`icon.svg`、`LICENSE`、`CHANGELOG.md`、`scripts`
  （build / check / test / verify / prepack），`npm pack` 内容显式声明。

## [0.1.0] — 2026-11-13

### Added
- Host 半：`explain_terms` 工具、系统提示段、`/learning-assistant` HTTP 路由、
  `$DSH_HOME/dsh-learning-assistant/terms.json` 记忆文件。
- Client 半：右侧栏「术语」标签、词条卡片、知识树视图、正文高亮
  （CSS Custom Highlight）、点击词定位卡片、双击卡片闪烁正文。
- 双向定位的滚动校正（`waitForScrollSettle` + 落点复核）。
- 自检脚本覆盖两端共 40+ 断言，以及无头浏览器探针。
