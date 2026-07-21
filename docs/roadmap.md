# 知发（bjfb）路线图

本文件管知发（bjfb）项目的跨阶段规划，前端导入 / 排期分配 / AI 撰写 / Skill 全链路等专项并存，全部在本文件维护，**不开多份 roadmap**。

**结构说明（2026-07-21 改造，参考 teacher 项目试点）**：本文件只保留「当前主线状态（按专项分组，每组五项固定结构）+ 待确认区 + 未排期 + 已关闭索引」；判断项目现在走到哪一步只看本文件，不需要通读全文。每个专项的详细背景、决策过程、验收标准下沉到 `docs/roadmap/`（已关闭）与 `docs/roadmap/pending/`（待确认）子文件。**子文件不写状态、不写进度、不写下一步**——文中残留的 ✅/🚧/⏸ 等状态记号只是下沉时的原文快照，判断当前状态只认本文件。

---

## 当前主线状态

### [v2.2] 崩溃诊断持久化  [详情 →](roadmap/v2.2-crash-diagnostics-persistence.md)
- 当前阶段: 🚧 进行中，主进程/渲染进程/调度器统一落盘的实现范围已定（`runtime-diagnostics.ndjson` + `last-runtime-state.json`）
- 一句话现状: 崩溃诊断落盘方案已设计，尚未见验收标准三项（renderer-error 事件、last-runtime-state 进度、异常退出后可定位）逐条通过的记录
- 阻塞: 无
- 最近验证: 缺（原文未记录验证结果）
- commit hash: 缺（原文未记录）

### [v2.5] Skill 共享执行层收敛  [详情 →](roadmap/v2.5-skill-shared-execution-layer.md)
- 当前阶段: 🚧 进行中，`skill_upload.py` 计划新增 scan-many/materialize-covers/schedule/build-records/postprocess/archive 六个子命令，`server.js` 计划新增 `POST /api/import/postprocess`
- 一句话现状: 目标是把 zhifa-pipeline 全链路流程下沉成共享执行层，消除会话级胶水（临时 JSON、手动 cp 封面、手拼 records），落地项与验收标准已列出但原文未记录完成情况
- 阻塞: 无
- 最近验证: 缺（原文未记录验证结果）
- commit hash: 缺（原文未记录）

---

## 待确认区（等用户裁决：还在做 / 已关闭 / 废弃归档）

无。

---

## 未排期

无（原文未见明确标注 ⏸ 的独立专项）。

---

## 已关闭

- 2026-06-15-同账号 6 小时排期约束 ✅ `344f31f` — 验证: 代码现状核对，`src/publish-guard.js`/`src/scheduler-allocator.js`/`scripts/skill_upload.py` 中 6 小时（360 分钟）约束已改为仅在 `constraints.minSameAccountIntervalMinutes` 显式传入时生效，发布执行不再按历史账本频控（提交信息注明另一会话 2026-06-27 已完成改动，本次代为提交，四个相关文件测试 23 pass）；后续已被 2026-07-15 专项统一为 361 分钟 topic-spacing-guard 约束 [详情 →](roadmap/2026-06-15-same-account-6h-schedule-withdrawn.md)
- v2.1-素材导入页 UI 重做 ✅ `8c01765`（2026-04-27，含 A-F 六阶段） — 验证: 代码现状核对，`public/index.html` 中 `allocateTimesByWindows`、`topicOverride`、`_importSelectedNoteKey`、`localeCompare(..., { numeric: true })` 均已落地并在用（主会话独立复核 grep 命中） [详情 →](roadmap/v2.1-import-ui-rework.md)
- 2026-07-15-同主题间隔与批量分散排期 ✅ `f0f291a`（功能实现）+ `db5d420`（必要回归测试） — 验证: 相关测试 32/34 通过（后续追加至 34/34）、Python/Node 语法通过、全量 79/80（唯一失败为既有账号映射基线问题、与本专项无关）；后续用户手动观察与既有账号映射基线修复列为未勾选待办，不计入本专项验收 [详情 →](roadmap/2026-07-15-topic-spacing-batch-schedule.md)
- 2026-07-11-正文硬边界补丁 ✅ `eccb2a7` — 验证: SYSTEM_PROMPT 新增「正文硬边界」四条并加载校验，node require 语法通过，`skills/zhifa-upload/SKILL.md` 提取命令改标记提取后实跑命中新段 [详情 →](roadmap/2026-07-11-body-boundary-patch.md)
- 2026-07-10-撰写规范二次重构 ✅ `0baa821` — 验证: `ai-writer-validate.test.js` 17 pass（账号映射 1 例既有失败与本次无关）、3 个代表主题真实 AI 调用通过、旧口径 grep 零残留、dist:mac 重打包后 build-info.json commit 与 HEAD 一致（尾巴：待用户重启 App 核对 UI 内 hash） [详情 →](roadmap/2026-07-10-writing-spec-v2-search-traffic.md)
- 2026-07-08-标题标签正文撰写规范重构 ✅ `42d2075`（观察期修复 `2e6a785`） — 验证: `ai-writer-validate` 17 pass + `server-import-create-records` 2 pass、独立冷眼审查有条件通过且 P1/P2 复测通过、dist:mac 打包覆盖安装；观察期场景词越权 bug 修复后 24 pass + 2 pass；遗留一条发现清单（标题双层分隔符暂无机械校验）未计入本次验收 [详情 →](roadmap/2026-07-08-title-tag-body-writing-spec-v1.md)
- v2.3-分组目录导入与小红书标题规则 ✅ `157d137` — 验证: 原文标注已完成，涵盖旧结构兼容、新三级结构识别、共享封面优先级、账号/日期/时间区间强制补齐等验收标准 [详情 →](roadmap/v2.3-grouped-import-xhs-title-rules.md)
- v2.4-Skill账号分组契约 ✅ `91c6067` — 验证: 原文标注已完成，两个 Skill 文档均按 `accountGroups`/`accountGroupAliases` 规则改写，兼容旧版平铺账号清单 [详情 →](roadmap/v2.4-skill-account-group-contract.md)
- v3.0-全链路ClaudeSkill（PPT→融景→知发） ✅ `6723314` — 验证: 上传层/全链路两个 Skill、辅助脚本、封面重命名、文案生成确认环节、多组批量匹配均标注完成，含冷眼审查修复记录 [详情 →](roadmap/v3.0-fulllink-claude-skill.md)
- 历史归档（v1.3.0 基线 + v2.0 素材导入与主题撰写 P0-P4，17 项子任务） — 证据不全（原文全程无 commit hash，早期版本未记录），不作完成宣称，保留为背景索引；已被 v2.1/v2.3/v2.4/v3.0 等后续有 hash 的专项验证其基础可用 [详情 →](roadmap/historical-baseline-v1.3-v2.0-p0-p4.md)
