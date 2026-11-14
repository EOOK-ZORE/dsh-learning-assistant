# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
