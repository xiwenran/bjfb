---
name: zhifa-pipeline
description: PPT一键发布全链路：从PPT文件到飞书多维表格发布记录的全自动化流水线。触发词：批量制作笔记、PPT一键发布、PPT做成笔记发布、PPT转笔记上传、全链路发布、做完直接发、一次做完发布、做好发到小红书、做好发到抖音、PPT做成笔记发抖音、PPT做成笔记发小红书、全流程发布、家长会笔记制作、家长会笔记发布、批量发布笔记、课件转笔记、笔记批量上传。
---

# zhifa-pipeline — PPT → 融景合成 → 飞书建档 全链路 Skill

从 PPT 文件夹开始，全自动完成：PPT 导出图片 → 融景合成笔记图 → 封面自动放置 → 调度矩阵生成 → 标题标签生成（用户确认） → 上传飞书建档 → 已安排/未安排归档 → 冷眼审查。

**发布状态统一设「待处理」**：上传时发布状态留空（知发设计），Step 6.8 后处理统一设为「待处理」。用户在飞书检查确认后手动改为「待发布」触发调度。

## 共享执行层（2026-06-04 起）

全链路和上传层统一复用 `~/zhifa/scripts/skill_upload.py` 的共享子命令：

- `scan-many`：合并多主题扫描结果
- `materialize-covers`：把主题根目录封面批量下发到模板目录
- `schedule`：基于扫描结果和账号/时段参数生成调度矩阵；支持底层 `accounts + timeSlots`，也支持日常口径 `accounts + timeWindows`
- `build-records`：基于扫描结果、调度结果和文案映射生成 records，并把时间窗展开成随机具体发布时间，避免所有账号撞点
- `create`：自适应分批上传 records；飞书限频失败必须进入低频补传并合并结果文件
- `postprocess`：上传成功后清空 `笔记主题`，并按实际平台设置 `待处理`
- `archive`：按调度结果归档已安排 / 未安排

要求：
- 不再使用会话内临时脚本或手工 JSON 拼接替代这些共享步骤
- `zhifa-pipeline` 与 `zhifa-upload` 只允许在入口和停顿点上不同，底层执行层必须收敛
- PPT → 融景合成完成后，一旦进入“笔记上传”阶段，必须切到同一套 `scan-many → materialize-covers → schedule → build-records → create → postprocess → archive` 链路

---

## 0. 入口契约（先读这里）

**用户提需求前，复制填写 CHECKLIST：**

```
~/zhifa/skills/zhifa-pipeline/CHECKLIST-用户提需求模板.md
```

必填项：素材根目录、分组账号规则、每账号每时段几篇、覆盖策略。可选项：时段调整、特殊账号起始日期。

**覆盖策略现在是必确认项**，不得再隐含默认。主会话必须明确向用户展示三选一：

- `严格覆盖`：账号多、主题多、篇数足够时，要求每个账号都尽量覆盖全部主题；覆盖不全记为 `violation`
- `尽量覆盖`：优先分散主题，但允许部分账号不覆盖全主题；只提示，不拦截
- `只保底发布`：只保证每个账号有内容发出，不要求覆盖全部主题

如果用户没说，默认**推荐** `只保底发布`，但仍必须显式问一句：`本轮覆盖策略用哪一种？`

**账号清单与分组规则自动加载**：用户说出触发词时，先读取本地账号文件并输出给用户确认：

```bash
cat ~/Library/Application\ Support/Zhifa/accounts.json
```

输出当前小红书、抖音账号列表，以及 `accountGroups` 内容分组映射。账号分组是发布策略，不改变素材目录结构；用户仍只需要整理 `导入根目录 / 内容分组 / 笔记或PPT主题`。

推荐 `accounts.json` 结构：

```json
{
  "xiaohongshu": ["账号A", "账号B"],
  "douyin": ["账号C"],
  "accountGroups": {
    "教务资料": {
      "xiaohongshu": ["账号A", "账号B"],
      "douyin": ["账号C"]
    },
    "英语类": {
      "xiaohongshu": ["账号A"],
      "douyin": [],
      "douyinMode": "manual"
    },
    "综合类": {
      "xiaohongshu": ["账号B"],
      "douyin": ["账号C"]
    }
  },
  "accountGroupAliases": {
    "教务类": "教务资料",
    "英语": "英语类",
    "中考语法": "英语类",
    "综合组": "综合类"
  }
}
```

用户在 CHECKLIST 里已明确列了分组账号规则时，以用户列的为准，跳过自动加载。账号变更时（加/减账号，或修改某内容分组账号池），任务完成后顺手更新 `accounts.json`。

**账号分组优先级**：
1. 用户本次 CHECKLIST 明确写出的账号 / 分组账号规则，优先级最高
2. `accounts.json.accountGroups[内容分组]` 命中时，作为默认推荐
3. 未精确命中时，先查 `accounts.json.accountGroupAliases[内容分组]`；例如 `教务类` → `教务资料`、`中考语法` → `英语类`
4. 别名仍未命中时，允许做规范化模糊匹配：去掉 `类/组/资料/素材` 等泛化后缀后再比较；只能在唯一命中时自动映射，多候选必须回问
5. 未命中分组配置时，只能把旧版平台平铺账号清单展示为候选，不得自动全选
6. 内容分组名包含 `英语`、`语法` 或 `中考语法` 时，默认归入 `英语类`；英语类抖音默认 `manual`，不自动生成抖音记录，除非用户明确说“这组也自动发抖音”
7. 缺账号、起止日期或时间段时，必须以选项形式追问用户，不能继续调度矩阵生成

**CHECKLIST 未填写 = 不启动流程**。

具体行为（**严格执行，不得简化**）：

1. 用户说出触发词（"开始制作 / 批量发布 / 做笔记发抖音 / 跑 zhifa-pipeline / 帮我做一下"等）但**未提供 5 项 CHECKLIST 信息**时，Claude 必须**立即把 CHECKLIST 模板正文完整贴出来**给用户复制填空——不要只回一句"请先填 CHECKLIST"，要把模板内容真的展示出来：

   ```bash
   cat ~/zhifa/skills/zhifa-pipeline/CHECKLIST-用户提需求模板.md
   ```

   把 cat 出来的内容直接放在回复里，告诉用户："请把这份模板复制下来，把空格处填好发回给我，我再启动流程。"

2. 不要替用户猜测任何必填项（即便能从最近会话推断），等用户明确填好回复
3. 5 项里只有"时段调整"和"特殊账号起始日期"是可选——其他 3 项缺一不可
4. 用户填好回复后才启动 9 步流程

### 中途介入模式（用户手动做了一部分后接入）

用户可能已经完成了前几步（合成图已有、调度矩阵已定、只需重传等），或者某步出了问题需要重做。这时不需要从 Step 1 重新开始。

**介入规则**：

1. **识别当前进度**：用户说「上传失败了重传」「模板分配有问题重做」「归档一下」等，先判断对应哪个 Step
2. **从该 Step 开始执行**，跳过已完成的步骤
3. **收尾必回（CRITICAL）**：无论从哪一步介入，**完成后必须从当前步骤往后走完剩余所有步骤**，特别是：
   - Step 6.5 上传验证 — 任何上传操作后必做
   - Step 7 归档 — 可以问用户「要归档吗？」但不能默认跳过
   - Step 8 冷眼审查 — **必须派独立审查子代理**，不能主会话自己做（主会话刚做完的东西自己审查 = 没有独立视角）。Codex 端按 Echo 规则声明 `子代理：冷眼审查 → model: gpt-5.5`。
   - Step 9 汇总报告 — 必做

4. **允许用户拒绝某步**：用户说「不用归档」「跳过审查」是合法的，但 AI 不能自己默认跳过

**中途介入的常见场景**：

| 用户说 | 从哪步开始 | 后续必做 |
|--------|-----------|---------|
| 「重新上传」「重传失败的」 | Step 6（上传） | 6.5 → 7 → 8 → 9 |
| 「模板分配重做」 | Step 4（调度矩阵） | 4 → 5 → 6 → 6.5 → 7 → 8 → 9 |
| 「标题改一下」 | Step 5（标题标签） | 5 → 6 → 6.5 → 7 → 8 → 9 |
| 「归档一下」 | Step 7（归档） | 7 → 8 → 9 |
| 「检查一下有没有重复」 | Step 6.5（验证） | 6.5 → 报告结果 |

### 禁止事项（CRITICAL）

❌ **不得再写 `/tmp/*.py` 或 `/tmp/*.js` 胶水脚本**：所有步骤已接口化，无需临时脚本。  
❌ 不得绕过本 skill 直接调用 `rongjing/cli.py`、`pipeline.py`、`skill_upload.py` 命令行，除非按本文件规定的参数格式。  
❌ 不得从工具级 skill（zhifa-upload、rongjing）切入全链路任务——本 skill 是全链路入口。  
❌ **完成上传后不得跳过 Step 6.5-9**——即使是中途介入，收尾步骤必须走完（用户明确说跳过除外）。

---

## 1. 已具备的底层接口

以下是本 skill **唯一合法调用入口**，不要绕过。上传阶段以共享 runner 为准；HTTP 接口只作为 runner 的底层实现或明确降级入口，不直接替代 runner：

| 工具 | 入口形式 | 作用 |
|---|---|---|
| `ppt-batch-tool/cli.py convert` | 命令行 | PPT → 图片 |
| `rongjing/cli.py process --cover-source` | 命令行 | 融景合成 + 自动放置封面（每个笔记文件夹写入 0.jpg / 0(1).jpg / 0(2).jpg）。**注意：`pipeline.py` 不支持 `--cover-source`**，要带封面必须直接调 `rongjing/cli.py process` |
| `zhifa/scripts/skill_upload.py scan-many` | 命令行 | 合并扫描多个主题目录，返回图片路径、视频路径、folderPath；替代直接散调用 `/api/import/scan-folder` |
| `zhifa/scripts/skill_upload.py materialize-covers` | 命令行 | 把主题根目录封面复制到每个模板目录，下发后必须重新 `scan-many` |
| `zhifa/scripts/skill_upload.py schedule` | 命令行 | 输入账号分组、覆盖策略、日期时段等计划 → 返回调度矩阵；替代直接散调用 `/api/import/schedule` |
| `zhifa/scripts/skill_upload.py build-records` | 命令行 | 基于 scan/schedule/content 生成 records JSON，展开 timeWindows 为具体分钟 |
| `POST /api/ai-writing/generate` | HTTP | AI 生成标题/正文/标签（标题公式失败时的 fallback） |
| `zhifa/scripts/skill_upload.py create` | 命令行 | 自适应分批上传 records 到飞书建档；遇到飞书限频时按低频补传合并结果 |
| `zhifa/scripts/skill_upload.py postprocess` | 命令行 | 上传成功后清空 `笔记主题`，只给实际平台设 `待处理` |
| `zhifa/scripts/skill_upload.py archive` | 命令行 | 上传完成后归档：已安排 → `已制作/已安排/[平台]/[主题]/`，未安排 → `已制作/未安排/[主题]/` |

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
| 平台搭配 | 平台独立——同一素材笔记可分别用于小红书和抖音；同一平台内仍不得重复分配同一 noteKey |
| 模板分配 | 由共享 `schedule/build-records` 生成并校验；重点保证同账号模板不过度集中、同主题跨账号尽量分散 |
| 主题分配 | 默认推荐 `只保底发布`；是否要求每账号覆盖全部主题，取决于用户确认的 `coverageStrategy` |
| 融景模板 | 全部可用模板（不传 `--templates`）；**模板数以 `rongjing/cli.py list-templates` 实查为准，不要照搬文档里的数字** |
| 标题公式 | 普通课文用公式 1-4；授课课件 / 复习课件 / 家长会 / 主题班会 / 班级管理 / 资料合集按公式 5-14 分类生成 |
| 标题字数 | 10-20 字（ai-writer 硬约束） |
| 标签数量 | 小红书 ≤10 / 抖音 ≤5 |
| 笔记主题（topic 字段） | **课文类**：填课文名（如"《背影》"）；**家长会/班会/非课文类**：留空，records JSON 中设 `"topic": ""`，noteKey 仍保留完整路径。**上传后 Step 6.8 强制清空**，防止调度器 AI 写作自动覆盖标题 |
| 描述（description） | 留空 |
| AI 写作 | 主会话先按公式手写 → 失败时 fallback 调 `/api/ai-writing/generate` |
| 发布状态 | 上传时留空，**Step 6.8 后处理统一设为「待处理」**，用户在飞书确认后手动改「待发布」触发调度 |
| 视频笔记 | 扫描时自动识别视频文件（.mp4/.mov 等），上传时视频→飞书「素材」字段、封面图（0.jpg）→飞书「视频封面」字段、内容类型→「视频」 |
| 上传后审查 | 自动派独立审查子代理冷眼审查（标题/标签/调度合规性；Codex 端用 `gpt-5.5`） |
| 反馈节奏 | 按阶段汇报，标题标签生成后等用户确认 |

### 调度与模板分散规则（CRITICAL）

调度矩阵和模板分散必须通过共享执行层生成，不允许主会话用 Python heredoc / Node heredoc 临时手写分配。

```bash
python3 ~/zhifa/scripts/skill_upload.py schedule <scan.json> <plan.json> --output <schedule.json>
python3 ~/zhifa/scripts/skill_upload.py build-records <scan.json> <schedule.json> <content.json> <records.json>
```

`plan.json` 必须显式包含：
- `accountGroups` / `accountGroupAliases` 解析后的分组账号池
- 用户确认的 `coverageStrategy`
- 日期、时间窗、首日开始时间、每账号篇数
- 用户额外约束，如同账号最小间隔、同主题分散要求；共享执行层暂不支持的约束必须标明“本轮人工排期约束”，并在收尾列入待产品化项

**跨平台素材复用**：小红书和抖音是独立发布平台，同一篇素材笔记可以各自生成一条发布记录；排期器只禁止同一平台内重复使用同一 `noteKey`，不得把小红书已用过的素材全局排除给抖音。典型场景：教务类 8 篇真实笔记，小红书 4 个账号 × 2 天 = 8 条，抖音 3 个账号 × 2 天 = 6 条，应该可以同时排满。

校验不通过 → **立即停下报告，不允许继续上传**。特别是同账号模板严重集中、同一 noteKey 重复、账号+发布时间重复、图片路径不存在，都不能带病上传。

**反面教训**：2026-05-09 调度矩阵手写时每账号只分配 1 个模板，导致同一账号的 14 篇笔记视觉完全相同；2026-05-16 主会话用 heredoc 临时写调度矩阵，导致流程脱离 Skill；2026-06-05 又因临时排期和临时补传脚本导致大量上下文消耗。此后上传阶段必须收回共享 runner。

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

**分两步**（`pipeline.py` 不支持 `--cover-source`，要带封面必须拆开走）：

第一步 PPT → 图片：

```bash
python3 ~/ppt-batch-tool/cli.py convert \
  --input "<PPT 所在文件夹>" \
  --output "<输出目录>/PPT图片" \
  [--only-file "<单个 PPT 文件名>"] \
  --max-slides 17
```

第二步 融景合成 + 封面放置（对每个 PPT 导出的图片子文件夹各跑一次）：

```bash
python3 ~/rongjing/cli.py process \
  --input "<输出目录>/PPT图片/<PPT名>" \
  --templates 1 2 3 ... \
  --output "<输出目录>/合成图/<PPT名>" \
  --format JPEG \
  --cover-source "<封面源目录>"
```

- `--cover-source`：rongjing 自动识别两种模式——目录下直接有 `0(1).jpg/0(2).jpg/0(3).jpg` → 复制到所有模板子目录；目录下有多个主题子目录 → 按名称前 6 字符匹配。复制时重命名为 `0.jpg/0(1).jpg/0(2).jpg`
- 模板必须显式列出（`rongjing/cli.py process` 的 `--templates` 是必填项）；先 `python3 ~/rongjing/cli.py list-templates` 取实际可用列表
- 用户说"随机 N 个模板"时：从 list-templates 结果随机采样 N 个 name

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
python3 ~/zhifa/scripts/skill_upload.py scan-many "<输出目录>/合成图/<主题1>" "<输出目录>/合成图/<主题2>" ... --output <scan.json>
```

返回合并扫描结果（含 `noteKey`、`folderPath`、`images`、`videos` 数组）。向用户汇报：发现 N 个主题、每主题 M 个模板版本、共 K 篇笔记。

三层目录口径：若合成图目录是 `内容分组 / PPT主题 / 笔记子文件夹`，真实笔记是第三层“笔记子文件夹”；第二层 PPT 主题只写入 `pptTopic`，不算篇数。封面可在笔记子文件夹内，也可在 PPT 主题根目录共享，不能因缺少共享封面把 PPT 主题误判成一篇笔记。

混合结构必须停问：若某个 PPT 主题目录根部有直接内容图/视频，同时下级子文件夹也有素材，扫描必须阻断并询问用户“根部素材是否也算一篇笔记，还是只发布下级子文件夹”，不得静默猜测。

若封面来自主题根目录或扫描结果提示模板目录缺主序号 0 封面，立即执行：

```bash
python3 ~/zhifa/scripts/skill_upload.py materialize-covers <scan.json>
python3 ~/zhifa/scripts/skill_upload.py scan-many "<输出目录>/合成图/<主题1>" "<输出目录>/合成图/<主题2>" ... --output <scan_after_covers.json>
```

后续步骤使用 `<scan_after_covers.json>`，不要继续引用补封面前的旧扫描文件。

**错误处理**：返回空列表 → 检查上一步合成图是否生成正确，停下报告。

---

### Step 4：生成调度矩阵

实际执行以共享 runner 为准：

```bash
python3 ~/zhifa/scripts/skill_upload.py schedule <scan.json> <plan.json> --output <schedule.json>
```

- `plan.json`：由用户确认后的分组账号规则、覆盖策略、日期、时间窗、每账号篇数构造
- `accounts`：必须按 `accountGroups` / `accountGroupAliases` 展开到内容分组，英语/语法分组默认不展开抖音账号
- `coverageStrategy`：必须来自用户显式确认
- `timeWindows` / `timeSlots`：允许使用日常时间窗口径；`build-records` 会展开成具体分钟

返回 `{schedule, unscheduled, stats}`：`schedule` 每项 `{topic, noteKey, platform, account, publishTime}`。若 `publishTime` 仍是时间窗字符串，必须在 `build-records` 阶段展开成 `YYYY-MM-DD HH:MM` 的具体时间。

向用户展示调度概览（总篇数 = 126 / 28 分布的说明，各账号时间分布表）。

**错误处理**：接口返回错误 → 先 `GET /api/status` 确认服务在线，再报告给用户。

---

### Step 5：生成标题/标签 → 等用户确认（必停点）

**必须停在这一步等用户确认，然后才能继续 Step 6。**

**完整写作规范（CRITICAL — 字面注入，不许只写路径）**：

执行 Step 5 前，主会话**必须**先用 `sed -n '8,240p' ~/zhifa/src/ai-writer.js` 把 SYSTEM_PROMPT 字面文本提取出来，把内容**完整粘贴**到本步骤的工作上下文和子代理派单里（公式 1-14 + 示例全部）。不允许只写"请参考路径"或"子代理自行读取"。

生成标题前必须向用户明确写出：`标题规则来源：已读取 ~/zhifa/src/ai-writer.js 的 SYSTEM_PROMPT`。没写出这句，视为标题规则未进入本轮工作上下文。

优先派文本子代理生成所有笔记的标题和标签。Codex 端按 Echo 规则声明 `子代理：文本生成 → model: gpt-5.4-mini`；Claude 端按对应模型规则执行：

派单内容：
- 所有笔记的 noteKey 列表（含模板编号）
- 内容类型（普通课文用公式 1-4；授课课件用公式 5；复习课件用公式 6；家长会用公式 7 或 11-14；主题班会用公式 8；班级管理用公式 9；资料合集用公式 10）
- SYSTEM_PROMPT 字面文本：粘贴 `~/zhifa/src/ai-writer.js` 中 `SYSTEM_PROMPT` 的完整内容，不只给路径
- 约束：每篇标题 10-20 字，最多 1 个标点，同主题不同篇必须角度不同，不允许重复；课件类标题必须写"老师动作 + 学生/家长/班级结果"，禁止写成"课堂可用/重点清楚/老师可参考"这类资料说明词

子代理产出格式（JSON）：
```json
{
  "英语成绩不是突然掉的，而是先松的（版本一）/1": {
    "title": "英语掉分前早有信号，家长会上讲透了",
    "formula": "公式五",
    "char_count": 17,
    "violations": [],
    "tags": ["#家长会", "#班主任", "..."]
  }
}
```

主会话展示所有标题/标签，等用户说「确认」后才继续。预览不得只展示标题，必须包含「套用公式 / 字数 / 违规项」三列；违规项为 `无` 才能进入确认。确认后主会话将标题/标签合并写入 `/tmp/zhifa_records.json`。

```
📋 内容预览（请确认后说「确认」继续）

| noteKey | 标题 | 套用公式 | 字数 | 违规项 | 标签 |
|---|---|---|---:|---|---|
| 主题A/1 | …… | 公式三 | 18 | 无 | #主题A #教学设计 |
```

**fallback**：主会话生成失败时，调：
```bash
curl -sf -X POST http://localhost:3210/api/ai-writing/generate \
  -H "Content-Type: application/json" \
  -d '{"recordId":"<noteKey>", "topic":"<主题>"}'
```

fallback 返回只含 `title/description/tags` 时，主会话必须按 SYSTEM_PROMPT 重新补齐并复核 `formula/char_count/violations`，且违规项必须为 `无` 才能进入预览确认；不能手填一列后跳过公式复核。

---

### Step 5.5：上传前预检 + 冷眼审查（CRITICAL — 不通过不上传）

**事前定位（CRITICAL — 进入本 Step 前必做）**：

主会话在执行本 Step 任何动作之前，**必须在回复中粘贴本节标题及第一句原文**（从"### Step 5.5"到"必须先预检再上传"这段），作为"我读到了这一步"的事前定位证据。事前定位写不出 = 视为没意识到这一步 = 不允许推进。

**用户已审 ≠ 子代理审，绝不可豁免**：用户肉眼审的是标题质量，子代理审的是模板分配/调度合规/数据完整性这些**结构性问题**，两者审的根本不是同一件事。"用户已审 + dry-run 已过"不构成豁免理由。

用户确认标题标签后，先写入 `/tmp/zhifa_records.json`，然后**必须先预检再上传**。

#### A. 自动预检（dry-run）

```bash
python3 ~/zhifa/scripts/skill_upload.py create /tmp/zhifa_records.json --dry-run
```

预检项（全部通过才允许上传）：
1. **JSON 格式**：records 数组非空，每条 record 必填字段齐全
2. **图片路径**：每条 record 的 images 里所有文件路径真实存在于磁盘
3. **模板多样性**：共享排期校验——每个账号使用的模板种类充足，且不存在某账号模板过度集中
4. **时间间隔**：同账号的相邻发布时间差 ≥ 10 分钟
5. **无重复**：同平台内 noteKey 无重复、账号+发布时间 无重复；跨平台允许复用同一 noteKey

**dry-run 语义边界**：`--dry-run` 只代表上述 5 项结构校验通过；它不检查标题是否套用 SYSTEM_PROMPT 公式，也不判断标题吸引力。不得把 dry-run 通过表述为「标题合格」或「内容质量通过」。

任一项不通过 → 打印具体违规条目，**退出码非 0，不继续上传**。

#### B. 独立子代理冷眼审查（上传前的独立审查）

预检通过后，**必须派独立审查子代理**做一次独立审查（和 Step 8 上传后的审查不同——这次是防止「带着问题上传」）。Codex 端按 Echo 规则声明 `子代理：冷眼审查 → model: gpt-5.5`：

```
派单：
目标：上传前独立审查 /tmp/zhifa_records.json
审查项：
1. 模板分配：共享 `schedule/build-records` 的模板分散是否正确？有没有某账号模板过于集中？
2. 标题质量：是否套用 SYSTEM_PROMPT 公式？字数 10-20 字？同主题不同笔记角度是否不同？课件类标题是否写出"老师动作 + 对象结果"，而不是资料说明词？
3. 调度合理性：时间分布是否均匀？有没有某天某账号挤了太多篇？
4. 数据完整性：总数 = 账号数 × 每账号篇数？各账号篇数一致？
报告格式：每项 ✅/❌/⚠️，❌ 项必须修复后才允许上传
```

审查通过 → 继续 Step 6 上传。审查不通过 → 停下修复，修完重新跑 Step 5.5。

**子代理产出依赖锁（CRITICAL）**：

派独立审查子代理时，派单末尾**必须**要求子代理把审查结论写入 `/tmp/agent-return-step5.5-<uuid>.txt`（uuid 由子代理自己生成），并在返回中给出该文件路径。

主会话收到子代理返回后，**必须在回复中粘贴该文件的绝对路径**（不是粘贴内容、不是改写摘要、不是"已通过"四个字）。缺少文件路径 = 视为子代理未派 = 不允许推进 Step 6。

理由：纯文本回报可被主会话"摘要为已通过"或干脆伪造；落盘 + 引路径让用户可以 `cat` 文件原文核对，把"文本契约"变成"文件契约"。

**为什么上传前和上传后各审查一次**：上传前审查防止「带错数据上传」（模板分配错、时间冲突等结构性问题），上传后审查（Step 8）确认「飞书实际写入正确」（数量、完整性）。两次审查的关注点不同。

---

### Step 6：上传飞书建档

Step 5.5 预检 + 审查全部通过后，执行上传：

```bash
python3 ~/zhifa/scripts/skill_upload.py create /tmp/zhifa_records.json --output /tmp/zhifa_create_results.json
```

`skill_upload.py` 内置自适应分批，携带调度矩阵、标题、标签、images 路径。

**注意**：
- `images` 数组直接从 Step 3 scan 结果复用（含 size），不要重新生成
- `xiaohongshuChannel` 未指定时固定填 `"蚁小二"`
- 上传时发布状态字段留空（Step 6.8 后处理再根据用户意图补设）

**飞书限流防护（≥50 条必读）**：

飞书图片上传接口在密集请求时会限流，表现为 `upload_error` 逐批增多，最终连续全败。防护策略：

| 总条数 | 每批条数 | 批间间隔 | 说明 |
|--------|---------|---------|------|
| ≤20 | 5 | 3s | 正常速度 |
| 21-50 | 3 | 5s | 适度降速 |
| 51-100 | 2 | 8s | 保守策略，每条记录含 10-15 张图片时飞书压力大 |
| >100 | 2 | 10s | 极保守 |

**断点续传（连续 3 批全败后的重试策略）**：

```bash
python3 ~/zhifa/scripts/skill_upload.py create /tmp/zhifa_records.json --retry-failed --output /tmp/zhifa_retry_results.json
```

`--retry-failed` 自动从上次运行结果中提取失败的 noteKey，只重传失败的，不传全量。等待 60s 后再执行（让飞书限流窗口过去）。重复直到全部成功或用户放弃。

**防重复硬规则（CRITICAL — 宁可失败也不允许重复）**：

- 上传前 `--dry-run` 检查同平台内 noteKey 和 账号+发布时间 无重复
- 服务端指纹查重是最后一道防线：同一指纹的记录会被 skip，不会重复创建
- **超时或断开后绝对不能盲目重传全量**——必须先用 Step 6.5 的导入日志验证方法确认哪些已成功，只传剩余的
- 如果无法确认服务端状态（日志也看不到、服务也连不上），**停下等用户决定**，不自动重试

**错误处理**：
- 连续 3 批失败 → 终止，用 `--retry-failed` 走断点续传
- 单批超时（≥1800s）→ 先查导入日志确认实际写入了多少条，再决定是否补传
- 服务崩溃（connection refused）→ 检查服务进程，必要时重启知发 App，等 10s 再继续

---

### Step 6.5：上传完整性验证（不可跳过）

**事前定位（CRITICAL）**：主会话在执行本 Step 前必须粘贴本节标题及第一句原文。

**校验脚本原始 stdout 强制粘贴**：跑完下面的 Python 校验脚本后，**必须把脚本的原始 stdout 完整粘贴到回复里**（包括 `期望: 60, 上传成功: 60` 这种数字行）。不允许只写"已校验通过"四个字——必须有数字证据让用户当场核对。

上传完成后、归档前，**必须验证全部 noteKey 都已成功写入飞书**。

**验证方法（用本地导入日志，不依赖慢接口）**：

```python
import re, json
from collections import Counter

# 1. 从导入日志提取今天的成功 noteKey
with open('~/Library/Caches/Zhifa/logs/import-debug.log') as f:
    lines = f.readlines()

today = '2026-XX-XX'  # 替换为实际日期
success_nks = []
for line in lines:
    m = re.match(rf'.*\[{today}T(\d{{2}}:\d{{2}}:\d{{2}}).*createRecord 成功 noteKey=(.*) =====', line)
    if m:
        success_nks.append((m.group(1), m.group(2)))

# 2. 只取本轮上传时间段（排除之前被删的旧记录）
# 找到上传开始时间后的记录
v2_nks = [nk for t, nk in success_nks if t >= 'HH:MM:SS']  # 替换为本轮开始时间

# 3. 与期望 noteKey 对比
with open('/tmp/zhifa_records.json') as f:
    expected = set(r['noteKey'] for r in json.load(f)['records'])

uploaded = set(v2_nks)
missing = expected - uploaded
dupes = {k: v for k, v in Counter(v2_nks).items() if v > 1 and k in expected}

# 4. 报告
print(f'期望: {len(expected)}, 上传成功: {len(uploaded)}')
if missing: print(f'缺失: {missing}')
if dupes: print(f'重复: {dupes}')
```

**验证标准**：
- ✅ 全部 noteKey 上传成功（uploaded ⊇ expected）
- ✅ 无重复（本轮内每个 noteKey 只成功 1 次）
- ✅ 各账号记录数一致（总数 ÷ 账号数 = 每账号篇数）

**验证失败 → 不继续归档**，先解决缺失或重复问题。

**为什么不用 `/api/records`**：该接口全量拉飞书记录，100+ 条时经常超时或返回空。本地导入日志是服务端实时写的，`createRecord 成功` = 飞书确认写入，可信度等同。

---

### Step 6.8：上传后强制后处理（CRITICAL — 不可跳过）

验证通过后、归档前，**立即**对所有成功创建的记录执行：

**① 清空笔记主题字段**：`create-records` 把 topic 写入飞书「笔记主题」列，若不清空，调度器的 AI 写作扫描会用笔记主题重新生成标题，覆盖 Step 5 预填的标题。

**② 设置发布状态**：统一设为「待处理」。用户在飞书检查确认无误后，手动改为「待发布」触发调度器自动发布。

**执行方式**：优先使用共享执行层，不在会话里临时拼 FeishuClient 调用。

```bash
python3 ~/zhifa/scripts/skill_upload.py postprocess <records.json> <create_results.json> --output <postprocess_results.json>
```

`create` 必须输出完整上传结果 JSON，供 Step 6.5、Step 6.8 和 Step 8 复用；不得再临时手写脚本调用 `/api/import/create-records` 只为保存返回值。`postprocess` 必须输出结果文件，供 Step 8 上传后审查同时核对“创建成功”和“后处理成功”。FeishuClient 直连只允许作为共享命令不可用时的降级兜底，并必须向用户说明。

---

### Step 7：归档已安排/未安排笔记

实际执行以共享 runner 为准：

```bash
python3 ~/zhifa/scripts/skill_upload.py archive <source_dir> <target_dir> <schedule.json>
```

- `sourceDir` / `targetDir`：都必须是**绝对路径**
- `schedule`：已安排笔记，每项 `{noteKey, platform}`（可直接复用 Step 4 返回的 schedule，多余字段无害）
- `unscheduled`：未安排 noteKey 数组（Step 4 返回的 `unscheduled`）
- **注意是 copy 不是 move**：原 `合成图` 目录保留

归档逻辑：
- `schedule` 里的笔记 → `<targetDir>/已安排/[平台]/[主题]/[模板]/`
- `unscheduled` 里的笔记 → `<targetDir>/未安排/[主题]/[模板]/`

向用户汇报：归档到已安排 N 篇，未安排 M 篇。

---

### Step 8：冷眼审查

**事前定位（CRITICAL）**：主会话在执行本 Step 前必须粘贴本节标题及第一句原文。

**子代理产出依赖锁（CRITICAL）**：派单末尾要求子代理把审查结论写入 `/tmp/agent-return-step8-<uuid>.txt`，主会话收到后**必须粘贴文件绝对路径**（不粘贴内容/不改写摘要）。缺少文件路径 = 步骤未完成 = 不允许进 Step 9。

**必须派独立审查子代理**，主会话不能自己做——刚做完的人审查自己的产出没有独立视角。Codex 端按 Echo 规则声明 `子代理：冷眼审查 → model: gpt-5.5`。

派单时提供 `/tmp/zhifa_records.json`（或 `_v2.json`）路径，让子代理自己读文件审查：

```
派单：
目标：独立审查本次 zhifa-pipeline 的上传数据
数据文件：/tmp/zhifa_records.json（或 /tmp/zhifa_records_v2.json）
导入日志：~/Library/Caches/Zhifa/logs/import-debug.log

审查项（读 JSON 文件 + 导入日志，每项给 ✅/❌/⚠️）：
1. 模板多样性：每个账号使用的模板种类是否充足？是否存在某账号模板过度集中？
2. 标题：字数 10-20 字？同主题不同笔记标题角度是否不同？有无重复？
3. 标签：小红书 ≤10 个？格式正确？
4. 调度合规：同账号同时段无重复主题？无同一笔记双平台？时间间隔 ≥10 分钟？
5. 上传完整性：导入日志中成功的 noteKey 数 = JSON 中记录数？无重复上传？
6. 各账号记录数一致：总数 ÷ 账号数 = 整数？
```

审查结果展示给用户（格式：每项 ✅ / ❌ / ⚠️ + 说明）。

---

### Step 9：汇总报告

```
✅ 全链路完成

PPT 处理：X 个文件，每个导出 N 页
融景合成：X 主题 × Y 个模板 = Z 篇笔记
调度矩阵：分配给 A 个小红书账号 + B 个抖音账号，共 K 条发布任务
知发上传：Z 篇成功导入飞书（笔记主题已清空 + 发布状态已按用户意图设置）
归档：已安排 N 篇 → 已制作/已安排/  未安排 M 篇 → 已制作/未安排/
冷眼审查：[通过 / 发现 N 项问题（见上方审查报告）]

合成图目录：<输出目录>/合成图
```

---

## 4. 三模型分工

本 skill 内部所有步骤已接口化，**不需要为普通发布流程派代码 worker 写临时脚本**。

| 角色 | 在本 skill 的职责 |
|---|---|
| 主会话 | 编排 9 步流程、判断异常、组织用户确认点 |
| 文本子代理 | Step 5 标题/标签生成；Codex 端默认 `gpt-5.4-mini`，复杂内容可升 `gpt-5.4` |
| 冷眼审查子代理 | Step 5.5 上传前审查 + Step 8 上传后审查；Codex 端用 `gpt-5.5` |
| 代码 worker | 仅当共享执行层本身缺能力或脚本报错需要修代码时才派；普通发布流程不得写临时脚本替代 runner |

---

## 5. 失败处理规则

| 故障类型 | 处理方式 |
|---|---|
| 任何接口超时/失败 | 先 `GET /api/status` 读服务端真实状态，再决定下一步（不盲目重试） |
| 上传批次失败连续 3 次 | 终止，报告给用户，附已上传/未上传笔记清单 |
| 标题生成不通过自检（字数/禁用词） | fallback 调 `/api/ai-writing/generate`，失败则报告给用户手动填写 |
| `ppt-batch-tool` 崩溃 | 报告完整错误信息，不重试，让用户决定 |
| 飞书字段不存在 | 不静默跳过，停下告知用户并提供三选一：我帮你建、你自己建、跳过这个字段 |
| client 断开 ≠ server 完成 | 断开后用 Step 6.5 的本地导入日志（`import-debug.log`）确认实际写入了哪些 noteKey，再决定是否补传（不要用 `/api/records`，100+ 条会超时） |

---

## 6. 与其他 Skill 的关系

本 skill 是**自包含的全链路入口**，内部串联以下工具，上层无需单独调用：

- `ppt-batch-tool`（PPT 导出，用 `cli.py convert`）
- `rongjing`（融景合成 + `--cover-source` 封面放置，用 `cli.py process`）
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
- 封面放置内建到 `rongjing/cli.py process --cover-source`，无需脚本（`pipeline.py` 本身不支持该参数，带封面走 Step 2 的两步命令）
- 调度矩阵内建到 `/api/import/schedule`
- 归档内建到 `/api/import/archive`
- 上传自适应分批内建到 `skill_upload.py`

**结论：进对入口，跨项目盲区根本不存在。** 详细复盘见 `~/Obsidian/PersonalWiki/项目/知发/changelog/2026-05-07.md`。

---

### 事故二（2026-05-09）：模板分配 + 飞书限流 + 验证困难

**事故经过**：98 篇笔记（14 主题 × 7 账号），调度矩阵手写时每账号只分配 1 个模板（账号1→模板1，账号2→模板2），导致同一账号的 14 篇笔记全部使用同一模板，视觉完全雷同。用户发现后手动删除飞书全部记录，改用拉丁方公式重新分配后重传。

重传过程中飞书图片上传限流，98 条分 33 批（每批 3 条），从第 15 批开始大量失败，最终 47 成功 / 46 失败。后续 3 轮断点续传才全部补上。验证阶段 `/api/records` 反复超时，最后改用本地导入日志（`import-debug.log`）交叉验证确认 98 条全部到位。

**踩坑点**：

1. **模板分配**：Skill 只写了「同账号不重复模板，随机轮询」，太模糊，主会话没理解「不重复」的粒度是跨主题而非跨账号。**已修复**：增加拉丁方公式 + 强制校验代码。

2. **飞书限流**：`skill_upload.py` 的自适应分批（`decide_batch_params`）对 50-100 条的场景太激进（每批 10 条、间隔 3s），每条记录含 10-15 张图时飞书扛不住。**已修复**：增加按图片密度调整的分批策略表。

3. **验证方式**：`/api/records` 拉全量记录在 100+ 条时不可用。**已修复**：增加 Step 6.5 基于本地导入日志的验证方法。

4. **重试效率**：每轮重试都传全量 98 条，已成功的靠指纹跳过但仍消耗飞书查询额度。**已修复**：增加断点续传流程（只传失败的 noteKey）。

5. **子代理没用**：Step 8 冷眼审查设计了独立审查子代理，但全程主会话自己做了所有事。根因：中途脱离 Skill 流程后就忘了回来。**教训**：即使中间介入，完成后也要回到 Skill 流程走 Step 8-9。
