---
name: zhifa-pipeline
description: PPT一键发布全链路：从PPT文件到飞书多维表格发布记录的全自动化流水线。触发词：批量制作笔记、PPT一键发布、PPT做成笔记发布、PPT转笔记上传、全链路发布、做完直接发、一次做完发布、做好发到小红书、做好发到抖音、PPT做成笔记发抖音、PPT做成笔记发小红书、全流程发布、家长会笔记制作、家长会笔记发布、批量发布笔记、课件转笔记、笔记批量上传。
---

# zhifa-pipeline — PPT → 融景合成 → 飞书建档 全链路 Skill

从 PPT 文件夹开始，全自动完成：PPT 导出图片 → 融景合成笔记图 → 封面自动放置 → 调度矩阵生成 → 标题标签生成（用户确认） → 上传飞书建档 → 已安排/未安排归档 → 冷眼审查。

**默认不自动发布**：上传后发布状态字段留空，由用户在飞书侧手动改为"待发布"后进入调度。

---

## 0. 入口契约（先读这里）

**用户提需求前，复制填写 CHECKLIST：**

```
~/.claude/skills/zhifa-pipeline/CHECKLIST-用户提需求模板.md
```

5 项必填：素材根目录、账号清单、每账号每时段几篇、时段调整（可选）、特殊账号起始日期（可选）。

**CHECKLIST 未填写 = 不启动流程**。

具体行为（**严格执行，不得简化**）：

1. 用户说出触发词（"开始制作 / 批量发布 / 做笔记发抖音 / 跑 zhifa-pipeline / 帮我做一下"等）但**未提供 5 项 CHECKLIST 信息**时，Claude 必须**立即把 CHECKLIST 模板正文完整贴出来**给用户复制填空——不要只回一句"请先填 CHECKLIST"，要把模板内容真的展示出来：

   ```bash
   cat ~/.claude/skills/zhifa-pipeline/CHECKLIST-用户提需求模板.md
   ```

   把 cat 出来的内容直接放在回复里，告诉用户："请把这份模板复制下来，把空格处填好发回给我，我再启动流程。"

2. 不要替用户猜测任何必填项（即便能从最近会话推断），等用户明确填好回复
3. 5 项里只有"时段调整"和"特殊账号起始日期"是可选——其他 3 项缺一不可
4. 用户填好回复后才启动 9 步流程

### 禁止事项（CRITICAL）

❌ **不得再写 `/tmp/*.py` 或 `/tmp/*.js` 胶水脚本**：所有步骤已接口化，无需临时脚本。  
❌ 不得绕过本 skill 直接调用 `rongjing/cli.py`、`pipeline.py`、`skill_upload.py` 命令行，除非按本文件规定的参数格式。  
❌ 不得从工具级 skill（zhifa-upload、rongjing）切入全链路任务——本 skill 是全链路入口。

---

## 1. 已具备的底层接口

以下是本 skill **唯一合法调用入口**，不要绕过：

| 工具 | 入口形式 | 作用 |
|---|---|---|
| `ppt-batch-tool/pipeline.py` | 命令行 | PPT → 图片 → 融景合成（含 `--cover-source` 封面放置） |
| `rongjing/cli.py --cover-source` | 命令行参数（内嵌在 pipeline.py 调用中） | 合成后自动放置封面（每个笔记文件夹写入 0.jpg / 0(1).jpg / 0(2).jpg） |
| `POST /api/import/scan-folder` | HTTP | 扫描合成图目录，返回 records 结构（含图片路径、folderPath） |
| `POST /api/import/schedule` | HTTP | 输入账号/时段/每时段篇数 → 返回调度矩阵（noteKey × 账号 × 时间槽分配） |
| `POST /api/ai-writing/generate` | HTTP | AI 生成标题/正文/标签（标题公式失败时的 fallback） |
| `zhifa/scripts/skill_upload.py create` | 命令行 | 自适应分批上传 records 到飞书建档（内置 `--ai-fallback`） |
| `POST /api/import/archive` | HTTP | 上传完成后自动归档：已安排 → `已制作/已安排/[平台]/[主题]/`，未安排 → `已制作/未安排/[主题]/` |

**知发 App 必须保持打开**（服务端口 `localhost:3210`）。每步前检查服务状态：

```bash
curl -sf http://localhost:3210/api/import/preflight
```

返回 `{"ok":true}` 才继续；失败则提醒用户打开知发 App 等 10 秒再试。

---

## 2. 默认行为（用户未说的全用默认）

| 项 | 默认 |
|---|---|
| 时段 | 6:20-7:30 / 13:00-13:30 / 19:00-19:30 / 21:00-22:00 |
| 平台搭配 | 永远独立——同一笔记不会同时发到小红书和抖音 |
| 模板分配 | 同账号不重复模板，随机轮询 |
| 主题分配 | 每账号覆盖全部主题，每主题最多 18 篇 |
| 融景模板 | 全部 22 个（不传 `--templates`） |
| 标题公式 | 家长会用公式 5-8（无课文名）/ 课文用公式 1-4 |
| 标题字数 | 10-20 字（ai-writer 硬约束） |
| 标签数量 | 小红书 ≤10 / 抖音 ≤5 |
| 描述（description） | 留空 |
| AI 写作 | 主会话先按公式手写 → 失败时 fallback 调 `/api/ai-writing/generate` |
| 发布状态 | 上传时不写（由用户在飞书侧管理） |
| 上传后审查 | 自动派 Sonnet 子代理冷眼审查（标题/标签/调度合规性） |
| 反馈节奏 | 按阶段汇报，标题标签生成后等用户确认 |

---

## 3. 标准工作流（9 步）

### Step 1：读 CHECKLIST + 扫描主题列表

1. 读取用户填写的 CHECKLIST 5 项
2. `ls` 素材根目录，自动发现主题子文件夹列表（无需用户单独提供）
3. 列出识别到的 PPT 文件和主题，等用户确认数量正确后继续

```bash
ls "<素材根目录>/笔记制作/"
```

**错误处理**：路径不存在 → 停下告知用户，不静默跳过。

---

### Step 2：PPT 导出图片 + 融景合成 + 封面放置

一条命令完成 PPT 导出、融景合成、封面自动放置：

```bash
cd ~/ppt-batch-tool && python3 pipeline.py run \
  --input "<素材根目录>/笔记制作" \
  --output "<输出目录>/合成图" \
  --cover-source "<素材根目录>" \
  [--templates 1 2 3 ...] \
  [--max-slides 17] \
  --format JPEG
```

- `--cover-source`：rongjing 从该目录下找 `XX逐字稿/0(1).jpg` 等封面文件，自动复制到每个笔记的合成图文件夹（无需手动 cp）
- 用户说"随机 N 个模板"时：先 `python3 ~/rongjing/cli.py list-templates` 取列表，随机采样 N 个 name，再传 `--templates`
- 不指定模板（或"全部"）时不加 `--templates` 参数

**输出结构**：
```
合成图/
  <主题A>/
    1/       ← 模板 1
      0.jpg  ← 封面（rongjing 自动放置）
      1.jpg  ← 内容图
      ...
    2/       ← 模板 2
    ...
  <主题B>/
  ...
```

等待完成（约 30 分钟/7 个 PPT），确认 `合成图/` 各主题下有子文件夹且封面 `0.jpg` 存在后继续。

**错误处理**：命令失败 → 报告完整错误信息给用户，不重试。

---

### Step 3：扫描合成图目录

```bash
curl -sf -X POST http://localhost:3210/api/import/scan-folder \
  -H "Content-Type: application/json" \
  -d '{"folderPath":"<输出目录>/合成图"}'
```

返回 records 列表（含 `noteKey`、`folderPath`、`images` 数组）。向用户汇报：发现 N 个主题、每主题 M 个模板版本、共 K 篇笔记。

**错误处理**：返回空列表 → 检查上一步合成图是否生成正确，停下报告。

---

### Step 4：生成调度矩阵

```bash
curl -sf -X POST http://localhost:3210/api/import/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "accounts": {
      "xiaohongshu": ["账号A", "账号B", ...],
      "douyin": ["账号X", ...]
    },
    "timeSlots": ["6:20-7:30", "13:00-13:30", "19:00-19:30", "21:00-22:00"],
    "perSlotCount": 1,
    "startDates": {
      "小陈老师": "2026-05-08"
    }
  }'
```

返回调度矩阵：每条 record 分配到 `{账号, 平台, publishTime}`。

向用户展示调度概览（总篇数 = 126 / 28 分布的说明，各账号时间分布表）。

**错误处理**：接口返回错误 → 先 `GET /api/status` 确认服务在线，再报告给用户。

---

### Step 5：主会话生成标题/标签 → 等用户确认（必停点）

**必须停在这一步等用户确认，然后才能继续 Step 6。**

1. 读取 `~/zhifa/src/ai-writer.js` 开头的 `SYSTEM_PROMPT`，获取标题公式、标签规则、禁用词
2. 每篇笔记**单独生成**标题（即使同一主题，标题角度必须不同）：
   - 依据内容类型（家长会用公式 5-8，课文用公式 1-4）
   - 写 2-3 个候选标题，标注对应公式编号
3. description 固定填 `""`
4. 按 SYSTEM_PROMPT 标签规范生成标签

展示所有主题的文案预览（标题候选 + 标签），等用户说「确认」后才继续。

**fallback**：主会话生成失败时，调：
```bash
curl -sf -X POST http://localhost:3210/api/ai-writing/generate \
  -H "Content-Type: application/json" \
  -d '{"recordId":"<noteKey>", "topic":"<主题>"}'
```

---

### Step 6：上传飞书建档

用户确认标题标签后，写入 `/tmp/zhifa_records.json`，再上传：

```bash
python3 ~/zhifa/scripts/skill_upload.py create /tmp/zhifa_records.json
```

`skill_upload.py` 内置自适应分批（每批 ≤10 条），携带调度矩阵、标题、标签、images 路径。

**注意**：
- `images` 数组直接从 Step 3 scan 结果复用（含 size），不要重新生成
- `xiaohongshuChannel` 未指定时固定填 `"蚁小二"`
- 上传时发布状态字段留空（不写"待发布"）

**错误处理**：
- 连续 3 批失败 → 终止，报告给用户决定是否重试
- 单批超时（≥1800s）→ 先 `GET /api/status` 检查服务端实际写入条数，不要盲目重试（防止重复记录）

---

### Step 7：归档已安排/未安排笔记

```bash
curl -sf -X POST http://localhost:3210/api/import/archive \
  -H "Content-Type: application/json" \
  -d '{
    "sourceDir": "<输出目录>/合成图",
    "scheduledNotes": ["<noteKey1>", "<noteKey2>", ...]
  }'
```

归档逻辑（服务端执行）：
- 已分配账号时间的笔记 → `已制作/已安排/[平台]/[主题]/`
- 未分配的笔记 → `已制作/未安排/[主题]/`

向用户汇报：归档到已安排 N 篇，未安排 M 篇。

---

### Step 8：冷眼审查

派 Sonnet 子代理独立审查本次上传结果：

```
派单：
目标：审查本次 zhifa-pipeline 上传结果
审查项：
1. 标题：字数 10-20 字？公式符合所选类型（家长会/课文）？是否有重复角度？
2. 标签：小红书 ≤10 个 / 抖音 ≤5 个？格式为 #xxx？
3. 调度：同账号在同一时段内无重复主题？无同一笔记双平台发布？
4. 总数：实际上传记录数 = 预期数（账号数 × 主题数 × 时段数 × 每时段篇数）？
提供：飞书记录截图或 GET /api/records 返回值
```

审查结果展示给用户（格式：每项 ✅ / ❌ / ⚠️ + 说明）。

---

### Step 9：汇总报告

```
✅ 全链路完成

PPT 处理：X 个文件，每个导出 N 页
融景合成：X 主题 × Y 个模板 = Z 篇笔记
调度矩阵：分配给 A 个小红书账号 + B 个抖音账号，共 K 条发布任务
知发上传：Z 篇成功导入飞书（发布状态留空，在飞书改"待发布"后进入调度）
归档：已安排 N 篇 → 已制作/已安排/  未安排 M 篇 → 已制作/未安排/
冷眼审查：[通过 / 发现 N 项问题（见上方审查报告）]

合成图目录：<输出目录>/合成图
```

---

## 4. 三模型分工

本 skill 内部所有步骤已接口化，**不需要派 Codex 或 Sonnet 做任何代码编写**。

| 角色 | 在本 skill 的职责 |
|---|---|
| 主会话（Sonnet/Opus） | 编排 9 步流程、Step 5 按公式写标题/标签、判断异常 |
| Sonnet 子代理 | **仅 Step 8 冷眼审查**（model: "sonnet"，只读，不改代码） |
| Codex | 本 skill 不涉及代码修改任务，不派 |

---

## 5. 失败处理规则

| 故障类型 | 处理方式 |
|---|---|
| 任何接口超时/失败 | 先 `GET /api/status` 读服务端真实状态，再决定下一步（不盲目重试） |
| 上传批次失败连续 3 次 | 终止，报告给用户，附已上传/未上传笔记清单 |
| 标题生成不通过自检（字数/禁用词） | fallback 调 `/api/ai-writing/generate`，失败则报告给用户手动填写 |
| `ppt-batch-tool` 崩溃 | 报告完整错误信息，不重试，让用户决定 |
| 飞书字段不存在 | 不静默跳过，停下告知用户并提供三选一：我帮你建、你自己建、跳过这个字段 |
| client 断开 ≠ server 完成 | 断开后先查服务端实际写入条数（`GET /api/records`）再决定是否补传 |

---

## 6. 与其他 Skill 的关系

本 skill 是**自包含的全链路入口**，内部串联以下工具，上层无需单独调用：

- `ppt-batch-tool`（PPT 导出 + pipeline.py）
- `rongjing`（融景合成 + `--cover-source` 封面放置）
- `zhifa-upload`（skill_upload.py，上传这一步的底层实现）

**什么时候直接用下层 skill：**

| 场景 | 用哪个 |
|---|---|
| 已有合成图，只需上传 | `zhifa-upload` |
| 只需跑融景合成，不上传 | `rongjing` |
| 只需 PPT → 图片，不合成 | `ppt-batch-tool` |
| 从 PPT 开始，全部做完发布 | **本 skill（zhifa-pipeline）** |

---

## 7. 反面教训（2026-05-07 整改记录）

**事故经过**：56 篇笔记任务，从工具级 skill `rongjing` 切入，把封面图 `0(1).jpg` 误判为内容图传入融景合成，56 篇全部报废。此后补救写了 5 个 `/tmp` 胶水脚本（`build_records.py`、`match_overwrite.py`、`cleanup_duplicates.js`、`batch_rongjing.py`、重组脚本），又触发 API timeout，产生 14 条飞书重复记录。全程纠错超过 4 小时。

**根因**：没走正确入口（`zhifa-pipeline`），而是从中间工具切入，导致对"0 开头 = 封面，1 开头 = 内容图"的约定不知情，脚本满天飞，状态对账失控。

**整改后**：
- `ppt-batch-tool/pipeline.py` 加 `--cover-source` 参数，封面放置内建，无需脚本
- 调度矩阵内建到 `/api/import/schedule`
- 归档内建到 `/api/import/archive`
- 上传自适应分批内建到 `skill_upload.py`

**结论：进对入口，跨项目盲区根本不存在。** 详细复盘见 `~/Obsidian/PersonalWiki/项目/知发/changelog/2026-05-07.md`。
