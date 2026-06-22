# zhifa-upload skill 实战问题记录

**日期**：2026-06-22
**任务规模**：18 个大主题（暑假作业 + 复习课件），展开成 42 个组、920 篇模板变体，抽样 63 篇，排期发布到 21 个账号（小红书 15 + 抖音 6），每号 3 篇，6.22 发 2 篇、6.23 早发 1 篇，同号两篇间隔 ≥6 小时。

**总体结论**：skill 主流程可跑通，未出现致命中断。但本次实战暴露了 3 处会造成返工或发布错误的坑：坑 1 直接影响发布时间正确性（干跑即报违规，必须手动重排 noteKey），坑 2 和坑 3 拖慢了准备效率，每处都额外消耗了多轮人工修正。以下逐一记录，供后续修 skill 时参考。

---

## 坑 1：跨平台复用 noteKey 导致发布时间错乱（优先级：高）

### 现象

排期时，抖音的 6 条记录复用了小红书已用的 noteKey（63 条实际只用了 45 个不同 noteKey）。`build-records` 生成记录后，`dry-run` 阶段报告 16 个时间间隔违规——同一账号名下两篇记录被挤进相同时间窗，发布时间仅相差几分钟，违反同号两篇 ≥6 小时间隔的红线规则。

### 根因

`scripts/skill_upload.py` 的 `resolve_window_publish_times` 函数（第 251 行）按 `noteKey` 为 key 分配发布时间：

```python
resolved: dict[str, str] = {}
for note_key, minute_offset in zip(shuffled_keys, minute_offsets):
    resolved[note_key] = (start_dt + ...).strftime(...)  # 第 281 行
```

该函数的 `resolved` 字典以 `noteKey` 为唯一 key。当同一 `noteKey` 被不同平台（小红书 + 抖音）的多条记录共用时，后赋值的平台会覆盖先赋值的平台的时间，导致两条记录最终拿到同一个时间点，6 小时间隔检查必然报违规。

`resolve_window_publish_times` 被调用于第 959 行：`resolved_publish_times = resolve_window_publish_times(schedule, rng=rng)`。

### 本次绕过方式

重新整理素材分配，让 63 条记录使用 63 个全局唯一的 `noteKey`（同一大主题下取不同模板变体编号作为 key），确保每个 key 只对应一条记录，规避了多对一覆盖问题。

### 建议改进（任选其一，需人工确认方案）

**方案 A（改时间分配逻辑）**：`resolve_window_publish_times` 的 `resolved` 字典改为以 `(platform, accountId, noteKey)` 或 `(recordId)` 为 key，而非单独 `noteKey`，彻底避免跨平台条目互相覆盖。

**方案 B（加前置校验）**：在 `build-records` 或排期步骤入口处，校验输入数据中 `noteKey` 是否全局唯一；若有重复，立即报错并输出冲突列表，让用户在生成记录前就修正，而不是到 dry-run 阶段才发现。

**方案 C（文档约束）**：若代码不改，在 SKILL.md 的排期说明中明确标注"noteKey 必须全局唯一，跨平台、跨时间窗的记录不得共享同一 noteKey"，并在示例中演示正确命名方式。

---

## 坑 2：文案标题字数（含标点）反复超 20（优先级：中）

### 现象

文案子代理多次生成超过 20 字的标题（含标点符号后达到 21 字），主会话与子代理来回修正了 3 轮才收敛。问题集中在复习课件类主题：主题名本身较长（如"单元 × 考点"形式），压缩到 ≤20 字需要明确的截短策略。

### 根因

`src/ai-writer.js` 的 SYSTEM_PROMPT（约第 194 行附近）要求"总长度 10-20 字"，但该约束是自然语言描述，生成端没有程序化校验。子代理生成后，skill 流程中也没有在写回飞书前自动检查字符数，超长标题直到人工抽查才被发现。

### 本次绕过方式

主会话手工检查每条标题的字符数，对超长标题手动压缩单元名或替换结果词，直到所有标题 ≤20 字。

### 建议改进

在文案写回飞书前（`build-records` 或 `import/create-records` 接口落库前），对 `title` 字段做程序化校验：

- 计算 `len(title)` （Python 中中文字符和标点均按 1 个字符计算）
- 超过 20 字的标题：① 自动标红并输出警告列表，要求人工修正后再继续；或 ② 记录为待修正状态，dry-run 时专项报告，不阻断其他记录
- 若采用 AI 自动截短，截短后需二次校验，避免截断造成语义损坏

---

## 坑 3：v2.0 扫描组的 `path` 字段为空导致 `materialize-covers` 失效（优先级：中）

### 现象

`scan-many` 输出的 42 个组中，29 个组（展开了"单元"子层的复习笔记组）的 `path` 字段为空字符串。执行 `materialize-covers` 时，`cmd_materialize_covers`（`skill_upload.py` 第 816 行）直接读取 `topic_entry.get("path")`（第 824 行），以此路径调用 `collect_cover_candidates` 寻找封面源目录。`path` 为空时，`collect_cover_candidates` 找不到任何封面，整组直接跳过（第 827–835 行），封面未下发到位。

### 根因

`cmd_materialize_covers` 只依赖组级别的 `path` 字段，而 v2.0 素材导入路径下，`scan-many` 对包含子层分组的组不生成 `path`（或生成为空），导致封面定位逻辑失效。但每条 note 的 `folderPath` 字段是各自文件夹的绝对路径，且始终有值，可以用来反向推导大主题根目录。

### 本次绕过方式

写临时脚本：遍历每条 note 的 `folderPath`，通过字符串前缀匹配找到对应的 18 个大主题根目录，从根目录的 `0_封面` 子文件夹取封面图，手动 `cp` 到各 note 的 `folderPath` 下，再重新 `scan` 注入封面信息。

### 建议改进

**方案 A（修 `materialize-covers` 回退逻辑）**：在 `cmd_materialize_covers` 中，当 `topic_path` 为空时，尝试从组内第一条 note 的 `folderPath` 向上溯源，找到该组对应的大主题根目录（可逐级 `os.path.dirname` 直到找到含封面候选的目录）。

**方案 B（修 `scan-many` 补全 `path`）**：`scan-many` 在生成组条目时，确保即使有子层分组，也给每个组补全 `path`，指向该组素材的根目录。

两个方案均需确认 `collect_cover_candidates` 对补全后路径的处理是否兼容。

---

## 优先级排序

| 优先级 | 坑 | 影响 |
|--------|-----|------|
| 高 | 坑 1：noteKey 跨平台复用 | 直接导致发布时间错乱，dry-run 报违规，必须重排；不修则每次多平台排期都要手动保证 noteKey 全局唯一 |
| 中 | 坑 2：标题字数无程序化校验 | 不影响流程成功，但多轮人工修正增加准备时间，主题名较长时必然复发 |
| 中 | 坑 3：`path` 为空跳过 materialize-covers | 不影响文字内容，但封面未下发需要手工补，v2.0 导入路径下必然复现 |

以上是本次实战中观察到的问题及初步改进建议，修 skill 前需人工确认具体方案。
