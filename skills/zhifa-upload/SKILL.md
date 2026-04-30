---
name: zhifa-upload
description: 知发上传：把融景合成图上传到飞书表格定时发布。触发词：上传到知发、上传到飞书、上传笔记、发布笔记、导入发布、准备发布、填封面发布、笔记上传发布。
---

# 融景合成图 → 知发上传 Skill

把融景已合成的笔记图，通过知发（zhifa，运行在 localhost:3210）上传到飞书多维表格，定时发布小红书 / 抖音。

## CLI 路径

```bash
python3 /Users/xili/zhifa/scripts/skill_upload.py
```

## 输入目录结构（融景标准输出）

```
合成图/
  课件A/          ← 主题文件夹（topic group）
    1/            ← 模板1（一篇笔记）
      1.jpg  2.jpg ...
    2/            ← 模板2（一篇笔记）
      1.jpg  2.jpg ...
  课件B/
    1/
      1.jpg  2.jpg ...
```

## 工作流程

### Step 0：确认参数

用户在**一条消息里**提供所有必要信息，之后只需在 Step 4 确认内容预览即可。

**标准输入格式：**

```
合成图文件夹：/Users/xili/笔记制作输出/合成图
账号：小红书-测试账号
发布时间：后天 15:00

组1：/Users/xili/Desktop/草船借箭封面.jpg
主题：草船借箭的历史背景与战争智慧

组2：/Users/xili/Desktop/赤壁之战封面.jpg
主题：赤壁之战：以少胜多的经典战例
```

参数说明：
- **合成图文件夹**：融景输出的 `合成图/` 目录路径
- **封面图**：每个主题组一张，请提供**完整磁盘路径**；文件名无所谓，Skill 统一存为 `0.jpg`
- **主题**：每组一句话，Claude 用于写小红书文案
- **账号**：小红书账号名 和/或 抖音账号名（可同时写两个）
- **发布渠道（xiaohongshuChannel）**：可选，默认 `蚁小二`；如果用其他渠道，用户需显式说明
- **发布时间**：支持自然语言（「后天 15:00」），Claude 需要先执行 `date "+%Y-%m-%d"` 拿到今天日期再推算绝对时间，最终填入格式 `YYYY-MM-DD HH:mm`

**关于封面图的附件（@ 拖入）**：如果用户通过 @ 或拖拽发送封面图，先运行：
```bash
ls -la <用户说的路径或附件路径>
```
确认文件确实存在后再 cp。**如果路径不确定，直接问用户"封面图的完整路径是什么？"**，不要猜。

### Step 1：检查知发服务

```bash
curl -sf http://localhost:3210/api/import/preflight
```

失败 → 提醒用户打开知发 App（macOS 菜单栏可见），等用户确认后继续。

### Step 2：扫描合成图文件夹

```bash
python3 /Users/xili/zhifa/scripts/skill_upload.py scan <合成图文件夹>
```

脚本会：
1. 打印人类可读摘要（每个主题组 + 包含的笔记 + 是否已有封面）
2. 把原始 JSON 写入 `/tmp/zhifa_scan_result.json`（Step 3、5 会用到）

**数量一致性检查**：如果扫出的主题组数量与用户提供的封面/主题数量不一致，停下来问用户：
> 「扫描发现 N 个主题组：[列出名称]，但你提供了 M 张封面。请告诉我哪张封面对应哪组，或者确认是否有组不需要封面。」

等用户明确确认后再继续 Step 3。

### Step 3：放置封面图

读取 `/tmp/zhifa_scan_result.json`，取出每个 topic group 下所有笔记的 `folderPath` 字段（已是绝对路径）。

**单张封面**（该组只提供一张图）：

```bash
cp "<封面图路径>" "<folderPath>/0.jpg"
```

**多张封面**（该组提供了多张图）：

按用户发送的文件名顺序排列（不要按文件系统排序，以用户列出的顺序为准），依次重命名为：

```
第1张 → 0.jpg
第2张 → 0(1).jpg
第3张 → 0(2).jpg
……以此类推
```

```bash
cp "<第1张路径>" "<folderPath>/0.jpg"
cp "<第2张路径>" "<folderPath>/0(1).jpg"
cp "<第3张路径>" "<folderPath>/0(2).jpg"
```

排序规则保证 `0 < 0(1) < 0(2) < 1 < 2…`，所有封面图始终排在内容图前面。

- 同一主题组的多个模板子文件夹（`1/`、`2/`、`3/`）放**完全相同**的封面组合
- 放完后再运行一次 `scan`，确认所有笔记都显示"含 0.jpg ✓"

### Step 4：Claude 生成文案

为每个主题组生成小红书文案（同一主题组的多个模板共用同一套内容）：

- **标题**：≤20 字，吸引人，口语化，结尾可带 ❓💡✨ 等符号，**不要** `#话题`
- **正文**：200–400 字，有实质干货，口语化，结尾 3–5 个 `#话题标签`
- **标签**：3–5 个关键词（不带 `#`，用于飞书「标签」字段）

生成后展示预览，等用户说「确认」后才继续：

```
📋 内容预览（请确认后说「确认」继续）

── 组1：草船借箭的历史背景与战争智慧 ──
标题：草船借箭，诸葛亮凭什么敢这么赌？
正文：（前 120 字）……
标签：历史故事 / 三国 / 战争智慧

── 组2：赤壁之战：以少胜多的经典战例 ──
…
```

### Step 5：构建 records JSON 并上传

从 `/tmp/zhifa_scan_result.json` 中读取扫描结果，结合用户输入和 Claude 生成的文案，构建完整 records 列表后，**在写入文件前做带约束的随机排列**，再写入 `/tmp/zhifa_records.json` 并上传。

**排列约束规则**（防平台识别模板化，两条必须同时满足）：

1. **同一模板不得相邻**：`noteKey` 末段（模板编号）与紧邻的上一条不能相同
2. **同一课题最多连续 2 条**：`topic` 与紧邻的上两条不能完全相同

**实现方式**（Python 贪心算法）：

```python
import random

def constrained_order(records):
    pool = list(records)
    random.shuffle(pool)   # 先随机打底，保证非决定性
    result = []

    while pool:
        for i, r in enumerate(pool):
            tmpl = r["noteKey"].split("/")[-1]
            topic = r["topic"]

            # 约束1：模板不相邻
            if result and result[-1]["noteKey"].split("/")[-1] == tmpl:
                continue
            # 约束2：同课题最多连续2条
            if (len(result) >= 2
                    and result[-1]["topic"] == topic
                    and result[-2]["topic"] == topic):
                continue

            result.append(pool.pop(i))
            break
        else:
            # 无法满足约束时（极少情况），追加剩余
            result.extend(pool)
            break

    return result
```

用此函数排列完成后再写入 `records` 数组。

```bash
python3 /Users/xili/zhifa/scripts/skill_upload.py create /tmp/zhifa_records.json
```

**字段来源说明**（构建每条 record 时参照）：

| 字段 | 来源 |
|------|------|
| `topic` | scan JSON 里的 `topic` 字段 |
| `topicOverride` | 用户提供的「主题」（写文案用的那句话） |
| `noteKey` | scan JSON 里每条 note 的 `noteKey` 字段 |
| `folderPath` | scan JSON 里每条 note 的 `folderPath` 字段（绝对路径） |
| `images` | scan JSON 里每条 note 的 `images` 数组（已含 name/path/size，**直接复用，不要重新构建**） |
| `xiaohongshuAccount` | 用户提供的小红书账号名，没有则留空 `""` |
| `douyinAccount` | 用户提供的抖音账号名，没有则留空 `""` |
| `publishTime` | 由 Step 0 推算的 `YYYY-MM-DD HH:mm` 格式绝对时间 |
| `xiaohongshuChannel` | 用户指定的渠道，**未指定时固定填 `"蚁小二"`** |
| `title` | Claude 生成的标题 |
| `description` | Claude 生成的正文 |
| `tags` | Claude 生成的标签数组（不带 `#` 的关键词） |

**records JSON 结构示例**（写入 `/tmp/zhifa_records.json`）：

```json
{
  "records": [
    {
      "topic": "课件A",
      "topicOverride": "草船借箭的历史背景与战争智慧",
      "noteKey": "课件A/1",
      "folderPath": "/Users/xili/笔记制作输出/合成图/课件A/1",
      "images": [
        {"name": "0.jpg", "path": "/Users/xili/笔记制作输出/合成图/课件A/1/0.jpg", "size": 98765},
        {"name": "1.jpg", "path": "/Users/xili/笔记制作输出/合成图/课件A/1/1.jpg", "size": 123456}
      ],
      "xiaohongshuAccount": "小红书-测试账号",
      "douyinAccount": "",
      "publishTime": "2026-04-30 15:00",
      "xiaohongshuChannel": "蚁小二",
      "title": "草船借箭，诸葛亮凭什么敢这么赌？",
      "description": "完整正文内容……",
      "tags": ["历史故事", "三国", "战争智慧"]
    }
  ]
}
```

**注意**：`title` 字段预填时，知发跳过自身 AI 生成，直接使用 Claude 写的文案。

### Step 6：报告结果

```
✅ 上传完成

处理 2 组，共 4 篇笔记：
  ✓ 成功 4 篇
  - 跳过 0 篇（已存在，指纹查重命中）
  ✗ 失败 0 篇

飞书表格已更新，可在知发里查看待发布队列。
```

## 注意事项

- 知发服务必须运行（macOS 菜单栏可见），否则 Step 1 会失败
- 查重：相同内容二次上传知发自动跳过（指纹查重），不会重复创建记录
- 封面图文件名无所谓，Skill 统一重命名为 `0.jpg`
- 多个模板共用同一封面：同一主题的 `1/`、`2/`、`3/` 文件夹都放相同的 `0.jpg`
- `images` 数组直接从 scan JSON 复用（含 size 字段），不要手动构建
