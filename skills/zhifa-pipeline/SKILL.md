---
name: zhifa-pipeline
description: PPT一键发布：PPT转图片+融景合成+知发上传，三段全链路自动完成。触发词：PPT一键发布、PPT做成笔记发布、PPT转笔记上传、全链路发布、做完直接发、一次做完发布、做好发到小红书、做好发到抖音、PPT做成笔记发抖音、PPT做成笔记发小红书、全流程发布。
---

# PPT → 融景合成 → 知发发布 三段全链路 Skill

三步合一：PPT 批量转图片 → 融景合成笔记图 → 知发上传飞书建档（**默认不自动发布**，发布状态字段留空，要人工改成"待发布"才进入调度）。
全程自动，用户只在中途确认一次 Claude 生成的文案内容。

## 依赖 CLI

```bash
python3 ~/ppt-batch-tool/pipeline.py   # PPT→图片+融景合成
python3 ~/zhifa/scripts/skill_upload.py # 上传知发
```

## 工作流程

### Step 0：一次性收集所有参数

用户在**一条消息**里提供以下所有内容，之后只停一次（Step 3 确认文案）：

**标准输入格式：**

```
PPT文件夹：~/Desktop/课件
输出目录：~/Desktop/笔记制作输出（可选，默认 PPT文件夹/../笔记制作输出/）
模板：全部（或 1 2 3 指定）
导出页数：17（默认）
账号：小红书-账号A、小红书-账号B、小红书-账号C、小红书-账号D、小红书-账号E、小红书-账号F
发布日期：5.1–5.2
时间段：11:10 / 13:00 / 20:00

组1：~/Desktop/草船借箭封面.jpg
主题：草船借箭的历史背景与战争智慧

组2：~/Desktop/赤壁之战封面.jpg
主题：赤壁之战：以少胜多的经典战例
```

- **PPT文件夹**：含 PPT/PPTX 文件的目录（递归扫描）；也可以是单个 PPT 文件路径
- **封面图**：每个 PPT 对应一张封面，请提供**完整磁盘路径**；顺序与 PPT 文件名排序一致（Step 1 完成后先列出发现的主题组，再与封面匹配确认）
- **主题**：每组一句话，Claude 用于写文案
- **账号**：一个或多个小红书/抖音账号，多个用顿号、逗号或换行分隔
- **发布日期**：支持「5.1–5.4」「后天到大后天」等自然语言；单天也可直接写「后天」；先执行 `date "+%Y-%m-%d"` 推算绝对日期
- **时间段**：一个或多个（如「11:10 / 13:00 / 20:00」），多时间段按规则二独立轮转；若指定了某账号固定时间，以指定为准
- **发布渠道**：可选，默认 `蚁小二`；如用其他渠道需显式说明
- 分配规则（主题轮转、时间轮转、模板多样）同 zhifa-upload SKILL.md「分配规则」章节
- **模板**：支持三种写法：
  - `全部`：使用所有可用模板（默认，不传 `--templates`）
  - `1 3 5`：指定具体模板编号
  - `随机3个` / `随机抽5个` 等自然语言：Claude 先执行 `python3 ~/rongjing/cli.py list-templates` 获取全部模板列表，再随机抽取 N 个编号，以 `--templates <编号列表>` 传入

### Step 1：PPT 导出图片 + 融景合成

```bash
cd ~/ppt-batch-tool && python3 pipeline.py run \
  --input <PPT文件夹> \
  --output <输出目录> \
  [--templates 1 2 3 ...] \
  [--max-slides 17] \
  --format JPEG
```

- 用户说"随机 N 个"时：先 `python3 ~/rongjing/cli.py list-templates` 拿列表，随机采样 N 个 name 字段，传 `--templates`
- 不指定模板（或用户说"全部"）时不加 `--templates` 参数，自动用全部可用模板
- 输出结构：
  ```
  输出目录/
    PPT图片/      ← 中间产物
    合成图/       ← 上传知发用的最终产物
  ```

等待完成后，确认 `合成图/` 目录存在且有内容，再继续。

### Step 2：检查知发服务

```bash
curl -sf http://localhost:3210/api/import/preflight
```

失败 → 提醒用户**打开知发 App**（桌面端），等十几秒让服务启动后再试一次。确认返回 `{"ok":true}` 后继续。

### Step 3：扫描合成图 + 放置封面

```bash
python3 ~/zhifa/scripts/skill_upload.py scan <输出目录>/合成图
```

脚本扫描结果会写入 `/tmp/zhifa_scan_result.json`（含每个笔记的 `folderPath` 绝对路径和 `images` 数组）。

列出发现的主题组，与用户提供的封面逐一确认对应关系。若数量不一致，停下询问用户：
> 「扫描发现 N 个主题组：[列出名称]，但你提供了 M 张封面。请告诉我哪张封面对应哪组。」

确认后，从 `/tmp/zhifa_scan_result.json` 取每条 note 的 `folderPath`，按以下规则放置封面：

**单张封面**：直接复制为 `0.jpg`。

**多张封面**（按用户发送的文件名顺序，不以文件系统为准）：

```bash
cp "<第1张>" "<folderPath>/0.jpg"
cp "<第2张>" "<folderPath>/0(1).jpg"
cp "<第3张>" "<folderPath>/0(2).jpg"
# 以此类推
```

排序保证 `0 < 0(1) < 0(2) < 1 < 2…`，封面始终在内容图前面。

同一主题的所有模板子文件夹（`1/`、`2/`、`3/`…）放**完全相同**的封面组合。放完后重新运行 `scan` 确认所有笔记都显示"含 0.jpg ✓"。

### Step 4：Claude 生成文案 → 用户确认

**每篇笔记单独生成文案，即使同一主题下有多篇，也必须各写各的——标题角度不同、切入点不同。** 不允许任何情况下复用同一套文案。

**完整写作规范**：执行前读取 `~/zhifa/src/ai-writer.js` 开头的 `SYSTEM_PROMPT`，严格按其中的标题公式、标签规则、禁用词执行。

**正文（description）固定留空** `""`，不生成任何正文内容。

#### 生成流程

1. 读取 `~/zhifa/src/ai-writer.js` 的 `SYSTEM_PROMPT`
2. 每篇笔记单独生成：依据内容类型选最贴切的标题公式，写 2–3 个候选标题
3. description 固定填 `""`
4. 按 SYSTEM_PROMPT 标签规范组装标签

展示所有主题的文案预览，等用户说「确认」后才继续。

### Step 5：上传到知发

从 `/tmp/zhifa_scan_result.json` 读取扫描结果（含 `images` 数组和 `folderPath`），结合文案和用户参数，按 zhifa-upload SKILL.md「分配原则」分配账号与时间槽后写入 `/tmp/zhifa_records.json` 并上传：

```bash
python3 ~/zhifa/scripts/skill_upload.py create /tmp/zhifa_records.json
```

分配原则、字段来源均同 zhifa-upload SKILL.md 对应章节；`images` 数组直接从 scan JSON 复用（含 size），`xiaohongshuChannel` 未指定时固定填 `"蚁小二"`。

### Step 6：归档未安排的笔记

上传完成后对照计划检查："制作了但没排进发布"或"用户备注不发"的笔记**复制**到 `<输出目录>/合成图/_未安排备用/`，命名 `{主题简称}-{原编号}-模板{融景模板号}/`，根目录写 README 说明。详见 zhifa-upload SKILL.md 同名步骤。

### Step 7：报告结果

```
✅ 全链路完成

PPT 处理：X 个文件，每个导出 N 页
融景合成：X 组 × Y 个模板 = Z 篇笔记
知发上传：Z 篇成功导入飞书（发布状态留空，需人工改"待发布"才发）
未安排归档：N 篇 → <输出目录>/合成图/_未安排备用/

合成图目录：<输出目录>/合成图（可单独拿来用）
PPT图片目录：<输出目录>/PPT图片（中间产物保留）
```

## 与 zhifa-upload Skill 的关系

- **zhifa-upload**：只做「上传」这一步，适合已有融景合成图时直接用
- **zhifa-pipeline**：三段全链路，从 PPT 开始，内部串联了 ppt-notes-pipeline + zhifa-upload

## 注意事项

- macOS 上 PowerPoint 首次运行会弹授权窗口，告知用户点「允许」
- 单文件模式不会触发额外授权（直接在原始目录操作）
- 融景模板需要提前在融景 App 里创建好（标注背景图角点）
- 知发 App 必须保持打开，服务才能响应请求；如果 preflight 检查失败，重新打开 App 等十几秒即可
- 查重：相同内容二次上传知发自动跳过
