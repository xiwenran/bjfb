> 原文快照：下沉自 docs/roadmap.md（2026-07-21 迁移），文中状态记号为历史残留

## ✅ 2026-07-08 — 标题/标签/正文撰写规范重构（单一源头 ai-writer.js，commit 42d2075）

- **目标**：标题改「搜索词层（系列词+资料词+细分主题）+ 钩子层（老师收益向封闭菜单）」双层结构并必带 1 个 emoji；正文从留空/50 字改为小红书换行排版（3-5 行、行首 emoji、50-150 字、首行含系列词/英文课题名）；统一字数口径（16-20 为主，硬边界 10-20）消灭 prompt 内部矛盾；生成后机械校验+重试 1 次，dry-run 加机械检查。样品已经用户三轮确认（老师收益向、Unit 名标题压缩正文补全、emoji+换行排版）。
- **涉及文件**：`src/ai-writer.js`、`scripts/skill_upload.py`（dry-run 检查）、`tests/ai-writer-validate.test.js`（新建）、`skills/zhifa-upload/SKILL.md`、`skills/zhifa-pipeline/SKILL.md`、`skills/zhifa-pipeline/CHECKLIST-用户提需求模板.md`。
- **验收标准**：
  - SYSTEM_PROMPT 全文只有一处字数表述；标题双层规则+钩子菜单+emoji 白名单+正文换行规范写入。
  - validateGenerated 机械校验（字数/emoji/标点/正文换行/标签上限），不过自动重试 1 次，再不过报错不静默放行；单测覆盖。
  - dry-run 能拦标题/标签/正文格式违规。
  - 两个 SKILL.md 与 CHECKLIST 与新 prompt 一致（description 留空条款删除、公式编号修正）。
  - 独立冷眼审查通过；commit 后重打包+覆盖安装+核对 UI commit hash。
- **阻断条件**：发现方案外功能想法只入发现清单；SKILL 文档与 prompt 不一致时停下对齐。
- **状态**：✅ 已完成（commit 42d2075。验证：tests/ai-writer-validate 17 pass + server-import-create-records 2 pass；旧口径 grep 零残留；独立冷眼审查有条件通过、P1/P2 已修复复测通过；dist:mac 打包 build-info 注入 42d2075 并已覆盖安装 /Applications。**尾巴**：运行中 App 仍是旧版 13d2da7，待用户重启后在 UI 左下角核对 hash=42d2075；用户计划观察一段时间标题/正文实际效果）
- **观察期修复**：2026-07-08 场景词越权 bug ✅（主题无场景词的备课课件被写成"暑假预习"；prompt 补课型判断第5-6条 + validateGenerated 场景词机械兜底，正文层按冷眼审查建议收敛防误伤教学动作描述。commit 2e6a785，验证：ai-writer-validate 24 pass + import 2 pass）
- **待补机械校验**（发现清单）：标题"必须含且仅含一个全角逗号分隔双层"暂无机械检查，标题无逗号时场景词检查退化为整句、可能误伤钩子文案；后续单独补

