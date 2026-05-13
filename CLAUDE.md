# CLAUDE.md — 知发项目记忆文件

> 本文件供 Claude Code 在每次会话开始时快速恢复上下文。请在每次重要变更后同步更新。

---

## 项目概览

**产品名**：知发（Zhifa）
**定位**：飞书多维表格驱动的笔记多平台自动发布桌面工具（Electron）
**支持平台**：小红书（蚁小二 API / 比特浏览器 Playwright）、抖音（蚁小二）
**GitHub**：https://github.com/xiwenran/bjfb
**用户语言**：中文（与用户沟通请用中文）

---

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Electron 37 |
| 后端服务 | Node.js HTTP（无框架，`src/server.js`） |
| 前端 | 单文件 SPA：`public/index.html`（全量 CSS + HTML + JS，~3200 行） |
| 飞书 | 自研 `src/feishu.js` 封装多维表格读写 |
| 浏览器自动化 | playwright-core（比特浏览器渠道） |
| 蚁小二 | axios HTTP 调用蚁小二开放 API |

---

## 文件结构

```
public/
  index.html          ← 前端全部代码（唯一前端文件）

src/
  server.js           ← HTTP 服务入口，所有 API 路由
  scheduler.js        ← 定时任务调度器（Scheduler 类）
  feishu.js           ← 飞书多维表格 API 客户端
  publisher.js        ← 蚁小二发布逻辑
  ai-writer.js        ← AI 写作模块（v1.3.0 新增）
  account-mapping.js  ← 蚁小二账号映射逻辑
  bitbrowser.js       ← 比特浏览器 API 封装
  bitbrowser-xhs.js   ← 比特浏览器 Playwright 小红书发布流程
  config-store.js     ← 配置读写、数据目录管理
  electron-main.js    ← Electron 主进程
  check.js            ← 配置自检工具

scripts/
  tag-backup.sh       ← npm run backup:tag
  git-sync.sh         ← npm run git:sync
  upload-local-mac-release.sh ← npm run release:mac-local

build/                ← 打包图标资源
CLAUDE.md             ← 本文件（Claude 记忆）
README.md             ← 用户文档
```

---

## 前端架构（public/index.html）

### 整体布局（三栏）

```
┌─────────────┬──────────────────────┬────────────────────────────┐
│ primary-rail│ workspace-main       │ workspace-preview          │
│ (108px)     │ (420–500px)          │ (flex:1, min 620px)        │
│             │                      │                            │
│ 导航图标    │ 卡片列表/表单        │ 动态右栏预览               │
│ 🏠📤⚙️📊   │ workspace-scroll     │ renderContextPreview()     │
└─────────────┴──────────────────────┴────────────────────────────┘
```

顶部有全局 `.app-header`（黑色，显示品牌+状态+操作按钮）。

### 4 个页面（Section）

| ID | 页面 | 图标 |
|----|------|------|
| `overview` | 总览 | 🏠 |
| `publish` | 发布 | 📤 |
| `setup` | 设置 | ⚙️ |
| `data` | 数据 | 📊 |

切换页面：`switchSection(sectionId)`
设置页有子页：`switchSetupPane(paneId)`

### CSS 核心变量

```css
--app-bg: #f2f1ef;          /* 主背景（暖灰） */
--panel: #ffffff;
--line: #e5e9e4;             /* 分割线 */
--accent: #07C160;           /* 主绿色 */
--accent-soft: #e4f5ea;      /* 浅绿（导航激活背景） */
--ink: #1d1d1f;
--shadow-card: 0 2px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(15,23,42,0.04);
```

特殊区域色：
- `.workspace-scroll`：`background: #f5f4f2`（中栏卡片区域）
- `.workspace-preview`：`background: #f3f8f5`（右栏，绿色调）

### 关键 JS 状态变量

```js
let currentSection = 'overview';       // 当前页面
let selectedRecord = null;             // 发布页选中记录
let recordListData = [];               // 发布记录缓存
let expandedAccountGroups = new Set(); // 账号分组展开状态
let recordSearchQuery = '';            // 搜索关键词
let scheduledTasksData = [];           // 定时任务列表缓存
let bitbrowserMappings = [];           // 比特浏览器映射
let latestStatusData = null;           // 服务状态缓存
let scheduledTasks = new Map();        // 前端定时任务（key: recordId:ts）
```

### 关键 JS 函数

| 函数 | 作用 |
|------|------|
| `switchSection(id)` | 切换主页面 |
| `renderContextPreview()` | 根据当前页面渲染右栏 |
| `renderOverviewPreview()` | 总览右栏：服务状态 + 定时任务 |
| `renderPublishPreview()` | 发布右栏：记录详情 + 立即发布按钮 |
| `renderRecordList(records)` | 渲染发布中栏（带分组+搜索过滤） |
| `toggleAccountGroup(key)` | 折叠/展开账号分组 |
| `filterRecords(query)` | 搜索过滤记录 |
| `publishRecord(recordId)` | 立即发布（最高优先级，取消定时任务） |
| `refreshStatus()` | 轮询服务状态 |
| `refreshRecords(force)` | 刷新发布记录列表 |
| `refreshScheduledTasks()` | 刷新定时任务列表 |
| `updateWorkspaceCopy()` | 更新中栏页眉文案 |
| `renderBitbrowserMappings()` | 渲染比特浏览器账号映射 |
| `addLog(level, msg)` | 添加前端日志 |
| `renderProgress(p)` | 更新发布进度显示 |
| `connectSSE()` | 建立 SSE 实时推送连接 |

### 发布页账号分组逻辑

- 按 `${xiaohongshuAccount}|${douyinAccount}` 分组
- 默认折叠，点击 group header 展开/收起
- `expandedAccountGroups` Set 存储展开状态，key 格式：`${sectionKey}:${accountLabel}`
- 搜索过滤在分组前执行，过滤后 ≤1 组时不显示 group header 直接平铺

### 工具栏布局（.workspace-toolbar）

```css
.workspace-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 16px 24px;
}
```
- 左列：页眉文字（`.workspace-head-copy`）
- 右列：状态 pills（`.toolbar-status`）+ 操作按钮行（`.toolbar-actions`）

**重要**：曾尝试改为 `flex-direction: column` 竖排，用户反馈"割裂突兀"，已恢复 2-column grid，**不要改回竖排**。

---

## 后端架构（src/server.js）

端口：`3210`（默认），环境变量 `NOTE_PUBLISHER_PORT` 可覆盖
所有路由在一个大 `requestHandler` 函数中，`if (pathname === '...' && method)` 逐一匹配。

### 重要 API 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/status` | 服务状态、待发数、进度 |
| GET | `/api/records` | 飞书未发布记录列表 |
| POST | `/api/publish/now` | 立即触发一轮扫描发布 |
| POST | `/api/publish/record` | **立即发布指定记录**（最高优先级） |
| GET | `/api/publish/scheduled-tasks` | 当前定时任务列表（含剩余时间） |
| POST | `/api/scheduler/start` | 启动定时服务 |
| POST | `/api/scheduler/stop` | 停止定时服务 |
| GET | `/api/accounts` | 蚁小二账号列表 |
| GET/POST | `/api/config` | 读写配置 |
| GET | `/api/logs` | 运行日志 |
| GET | `/events` | SSE 实时推送 |
| POST | `/api/config/ai-writing` | 保存 AI 写作配置（apiKey `******` 时保留原值） |
| POST | `/api/ai-writing/test` | 测试 AI 连接有效性 |
| POST | `/api/ai-writing/generate` | 手动为单条记录生成标题/正文/标签并回写飞书 |

**注意**：`readBody(req)` 返回的是**原始字符串**，需手动 `JSON.parse(body || '{}')`，不能直接解构。

---

## 调度器（src/scheduler.js）

### Scheduler 类关键属性

```js
this.scheduledTasks = new Map(); // key: `${recordId}:${publishTime.getTime()}`
this.publishing = false;         // 发布锁，finally 中保证重置
this.running = false;
this.logs = [];                  // 最多 200 条
```

### 关键方法

| 方法 | 说明 |
|------|------|
| `start()` | 启动定时服务；会立即补扫一轮飞书并继续处理未完成任务 |
| `stop()` | 停止；当前正在执行的记录会收尾，未开始的定时任务暂停 |
| `checkAndPublish()` | 扫描飞书，补建精准任务；每轮开始前先调 reconcileCloudPublishing |
| `reconcileCloudPublishing()` | 补查飞书中状态为”发布中”的记录，调蚁小二 /v2/taskSets 确认结果后写飞书+落账本 |
| `publishRecords(records, reason)` | 实际发布；支持队列并发、停止后不再继续吃后续排队任务 |
| `publishSpecificRecord(recordId)` | 立即发布指定记录，先取消该记录定时任务；仅处理平台状态为 `待发布` 的记录 |
| `scheduleRecordTask(record, time)` | 创建精准定时器，async 回调包裹在 `.catch()` 中 |
| `getScheduledTasks()` | 返回当前所有定时任务（含 `remainingMs`），供前端倒计时显示 |
| `recordHasContent(record)` | 校验记录是否有标题和素材，空内容记录跳过不建任务 |
| `runAiWriting(records)` | AI 写作扫描：过滤 24h 内修改 + topic 变化的记录，调 ai-writer 生成并回写飞书 |

### 近期稳定性修复（2026-04-02）

- 修复账号自动映射：刷新账号状态或发布前，会用飞书账号名匹配蚁小二账号名/别名，只有唯一精确匹配时才自动回写映射
- 修复发布并发：支持同一时间多条记录并发处理，默认 `rules.publishRecordConcurrency = 2`
- 修复重复发布回归：新增发布账本保护和最近成功记录保护，避免飞书状态回写延迟时同一条被重复提交
- 调整云发布状态：蚁小二云发布提交成功后先写为 `发布中`，不再直接写成 `已发布`
- 强化红线规则：自动调度、顶部”立即补发”、单条”立即发布”都只允许处理平台状态精确等于 `待发布` 的记录，`发布失败` 必须先人工改回 `待发布`
- 调整停止行为：点击停止后，只允许当前正在发布的记录收尾，后续排队和未开始的定时任务暂停
- 调整顶部按钮文案：总览页顶部按钮改为”立即补发”，表示只补发当前已到时间的内容，不会把未来定时任务全部发出

### 红线防护架构（2026-04-08 加固）

三层防护防止重复发布到多账号：
1. **C1 预查重**：发布前查 `/v2/taskSets`（fail-closed，查不到就不发），12 小时窗口
2. **R6 写入顺序**：先写飞书”已发布”，再落本地账本（飞书失败则本地不写，下轮由 C1 兜底）
3. **血统账本（publish-history.json）**：append-only，跨账号+跨 recordId 的 contentHash 去重

关键常量：`C1_DEDUP_WINDOW_HOURS = 12`

数据文件：
- `publish-ledger.json`（`~/Library/Caches/Zhifa/`）：recordId+platform 已发集合
- `publish-history.json`（同目录）：完整血统记录，原子写（tmp+rename）
- `ai-writing-cache.json`（同目录）：AI 写作缓存，存 `{recordId: {topic, generatedAt}}`，用于检测笔记主题是否变更

### 蚁小二 API 路径（2026-04-09 更新）

使用 `requestApiWithFallback`：主路径优先，404 自动降级旧路径。

| 功能 | 主路径（新） | 降级路径（旧） |
|------|------------|--------------|
| 账号列表 | `/v2/platform/accounts` | `/platform-accounts` |
| 任务列表/C1查重/轮询 | `/v2/taskSets` | `/taskSets` |
| 分类/话题 | `/platform-accounts/:id/categories` | `/platform-accounts/:id/topics` |
| 上传 URL | **只发** `fileName`+`fileSize`（fileKey 由服务端生成） | — |

> ⚠️ 上传 URL 接口禁止从客户端传 `fileKey`。2026-04-09 出过事故：客户端把 fileName 当 fileKey 传过去，蚁小二用它做 OSS 全局 key，5 条不同记录里同名图片互相覆盖，最终发出的 5 条笔记内容全是最后一次上传的那篇。修复方案：`getUploadUrlApi` 只发 `fileName/fileSize`；`uploadFileToOss` 给客户端文件名再加 `crypto.randomBytes(6)` namespace 兜底。

### scheduleNext 模式

```js
// checkAndPublish 内部捕获所有错误，不会抛出，所以 scheduleNext 一定执行
this.scanTimer = setTimeout(() => {
  (async () => { await this.checkAndPublish(); this.scheduleNext(); })()
    .catch(e => this.log('error', e.message));
}, delay);
```

---

## 数据目录

| 系统 | 路径 |
|------|------|
| macOS 配置 | `~/Library/Application Support/Zhifa/config.json` |
| macOS 数据 | `~/Library/Caches/Zhifa/` |
| Windows 配置 | `%AppData%/Zhifa/config.json` |
| Windows 数据 | `%LocalAppData%/Zhifa/` |

---

## AI 写作模块（src/ai-writer.js）

### 两条独立触发路径（重要，2026-04-25 补）

**路径 A：导入时直接调用（v2.0 新增，当前主路径）**
- 接口：`POST /api/import/create-records`
- 触发：用户在"素材导入"页点"主题撰写并预览"
- 入参：每篇笔记携带 `topic`（文件夹一级目录名，或 UI 里用户填的覆盖值）+ 图片文件名
- `dryRun=true` 时只生成内容返回，不写飞书；`dryRun=false` 完整链路上传图片+建记录
- **同主题下 N 篇笔记就生成 N 篇内容**（每个二级子文件夹一篇）
- 路线图 P3.0 / P3.1 已 ✅

**路径 B：调度器后台扫描（v1.3.0 老路径，仍保留）**
- 触发：飞书记录"笔记主题"字段有值 + 近 24h 内修改 + 内容与上次不同
- 由 `scheduler.runAiWriting()` 定时扫描，自动生成并回写飞书
- 适用：在飞书里直接改主题字段的场景

两条路径独立生效，互不冲突。

### 功能（路径 B 细节）

扫描飞书"笔记主题"字段，有值且近 24 小时内修改、且内容与上次不同时，自动调用 AI 生成标题/正文/标签并回写飞书。

### 支持的 Provider

| provider | 说明 | 接口格式 |
|---------|------|---------|
| `openai` | OpenAI 兼容（官方/中转/大多数第三方服务） | POST `{apiBaseUrl}/chat/completions` |
| `anthropic` | Anthropic Claude 官方 API | POST `https://api.anthropic.com/v1/messages`，`x-api-key` header |
| `gemini` | Google Gemini 官方 API | POST `https://generativelanguage.googleapis.com/...?key={apiKey}` |

Claude/Gemini 通过第三方中转站时，通常提供 OpenAI 兼容接口，选 `openai` 填中转 base URL 即可。

### 配置结构（config.aiWriting）

```js
aiWriting: {
  enabled: false,
  provider: 'openai',   // 'openai' | 'anthropic' | 'gemini'
  apiBaseUrl: '',       // openai 模式必填
  apiKey: '',           // GET /api/config 返回时掩码为 ******
  model: 'gpt-4o-mini', // anthropic 默认 claude-3-5-haiku，gemini 默认 gemini-2.0-flash
}
```

### 触发规则

1. `aiWriting.enabled === true`（设置页开关）
2. `record.modifiedTime >= Date.now() - 24h`（只处理最近 24 小时内修改的记录）
3. `record.topic` 非空
4. `topic` 与 `ai-writing-cache.json` 中上次生成时的值不同

### 输出格式

AI 生成结果通过 system prompt 要求严格输出 JSON：
```json
{"title":"...","description":"...","tags":["#标签1","#标签2"]}
```
回写飞书时标签以 `\n` 分隔（每行一个），与 `getTagValues` 的多行文本格式一致。

### 新增飞书字段

`parseRecord` 新增三个字段：
- `topic`：笔记主题（文本字段）
- `createdTime`：飞书记录创建时间（毫秒）
- `modifiedTime`：飞书记录最后修改时间（毫秒）

---

## 常用命令

```bash
npm start              # 启动 HTTP 服务（无 Electron）
npm run desktop        # 启动 Electron 桌面版
npm run dist:mac       # 本地打包 macOS zip
npm run dist:win       # 本地打包 Windows portable exe
npm run check:syntax   # 检查所有 src/*.js 语法
npm run backup:tag     # 创建本地 git backup tag
npm run git:sync -- "提交信息"  # add + commit + push
```

---

## UI 设计决策记录

### 已确认的设计方向
- **配色**：暖灰背景 `#f2f1ef`，绿色调右栏 `#f3f8f5`，深色顶栏 `#1d1d1f`
- **导航顺序**：顶部组 🏠总览 → 📤发布 → 📊数据；底部组（`margin-top:auto`）⚙️设置；最底部版本号
- **卡片**：`box-shadow` 提供层次感，hover 有 `translateY(-1px) scale(1.005)`
- **选中记录**：左侧绿色 border `border-left: 3px solid var(--accent)`
- **工具栏**：2-column grid，左边标题，右边 pills + 按钮，不能改成竖排
- **版本号**：左侧栏最底部，从 `/api/status` 返回的 `version` 字段读取，`id="appVersionLabel"`

### 明确拒绝的设计
- ❌ 工具栏 `flex-direction: column` 竖排（用户说"割裂突兀"）
- ❌ 中栏页眉下方显示 `<p>` 描述段落（文字10字/行太窄，已删除，描述只在右栏显示）
- ❌ 导航栏显示"导航"文字标签

---

## 已知 Bug 修复历史

| 时间 | 文件 | Bug | 修复方式 |
|------|------|-----|----------|
| 2026-03 | server.js | `/api/publish/record` body 未 JSON.parse，recordId 永远 undefined，立即发布完全失效 | 改为 `JSON.parse(body \|\| '{}')` |
| 2026-03 | scheduler.js | `scheduleRecordTask` 的 setTimeout async 回调无 `.catch()`，Feishu 失败时 unhandled rejection | 改为 `().catch(e => this.log('error', ...))` |
| 2026-03 | index.html | `updateWorkspaceCopy()` 调用 `getElementById('workspaceDescription')` 但元素已删除，null reference crash | 删除对应 JS 调用行 |
| 2026-04 | publisher.js | 打包后崩溃：`LEDGER_PATH is not defined` + `loadPublishHistory` 函数体被意外合并进 `savePublishedLedger` | 迁移到 config-store.js 的 `readLedger/readHistory/saveHistory` |
| 2026-04 | scheduler.js | cherry-pick 后 R6 修复（markPlatformStatus→appendHistory→markAsPublished 链）被丢失，云发布永远不落账本 | 手动补回完整链路 |
| 2026-04 | server.js | `isPendingRecord` 用 `!== '已发布'`，平台状态为空也被算入待发布计数 | 改为 `=== '待发布'`，与调度器 `isPlatformPending` 保持一致 |
| 2026-04 | index.html | `renderRecordList` 分组判断同上，空状态记录也显示在待发布区 | 改为白名单：只有 `待发布/发布中/发布失败/已发布(跨账号已拒绝)` 才归入待发布 |
| 2026-04-09 | publisher.js:218 | **重大事故**：`getUploadUrlApi` 主动传 `fileKey: fileName`，让蚁小二把客户端文件名当 OSS 全局 key，5 条不同记录里的同名图片（"1.png"/"封面.png"）互相覆盖，最终发出去的笔记内容**全部是最后一次上传的那篇**。本地账本仍是 5 个不同 contentHash（因为飞书 file_token 不同），所以红线没拦住——根因是上传链路被污染。 | 1) `getUploadUrlApi` 回滚到只发 `fileName/fileSize`，由服务端生成唯一 key；2) `uploadFileToOss` 给客户端文件名加 `crypto.randomBytes(6)` 随机 namespace 前缀作兜底，即便服务端 bug 也不会跨记录覆盖 |
| 2026-04 | feishu.js | 附件排序只提取前缀整数，`1(2).png`/`1.2.png` 内部顺序靠飞书上传顺序兜底 | 新增括号子序号和小数点子序号解析，`1(1)<1(2)`、`1.1<1.2` 均可靠排序 |
| 2026-04-09 | config-store.js:281 | `saveLedger` 是直接 `writeFileSync`，与 `saveHistory` 的 tmp+rename 不对称。scheduler 的写入顺序是 history 先 / ledger 后，进程在两次写之间被强杀会出现"血统说已发、ledger 没拦截"的不一致；ledger 写到一半被杀还会留下残缺 JSON，下次启动 `loadPublishedLedger` fail-closed 整个服务起不来 | 改为原子写：先写 `.tmp` 再 `rename`，与 `saveHistory` 对称 |
| 2026-04-09 | feishu.js:284 / scheduler.js:350 | `downloadAllAttachments` 用 `fs.renameSync` 写入飞书原始文件名，POSIX 上同名会静默覆盖；同一条记录里两张同名图会塌成一份，scheduler 让 attachments 与 videoCover 共用同一 `tmpDir` 也会跨集合污染（封面 vs 主附件同名时） | 1) 在 `downloadAllAttachments` 内部用 `usedNames` Set + `existsSync` 双重检测，遇到同名自动追加 `_2/_3...` 后缀；2) scheduler 把 cover 下载到 `tmpDir/cover/` 子目录，与主附件目录物理隔离 |

---

## 知发工作流子代理分工（防主会话上下文过重）

在执行 zhifa-upload / zhifa-pipeline / rongjing 等多步骤 skill 时，以下三类子任务必须派子代理，不允许全部放在主会话处理：

| 子任务类型 | 派哪个 | 典型场景 |
|-----------|--------|---------|
| 目录结构未知 / 新素材格式探索 | `Agent(subagent_type="Explore")` | 合成图目录结构是否符合预期、封面文件夹映射关系确认 |
| 机械性批处理脚本 | `Agent(subagent_type="codex:codex-rescue")` | 重整目录结构、批量复制封面到模板子文件夹、按图片数切分连续编号 |
| 内容生成 + 分配逻辑（>50 行 Python / JSON 构建） | `Agent(subagent_type="general-purpose", model="sonnet")` | build_records.py、标题批量生成、账号×主题×时间矩阵分配 |

判断口诀：「读文件 → Explore；写脚本 → Codex；生内容 → Sonnet」。进了 skill 不因为"全链路都在这里"而豁免子代理分工规则。

**立规则依据**：26春初中语文 192 篇笔记制作发布（2026-05-10）全程未用子代理，主会话上下文极重，多次 compact 丢失上下文；重整脚本、封面放置脚本、build_records.py 均应派子代理处理。

---

## 待办 / 潜在优化点

- [ ] SSE 重连目前无限循环，Electron 本地环境可接受，若需限制可加最大次数
- [ ] 音乐库状态 `musicLibraryState` 多个异步函数共享，极端情况可能竞态
- [ ] `refreshRecords()` 等 Promise 调用方未 await，失败时 UI 静默不同步（低优先级）
- [ ] reconcileCloudPublishing 的 accountId 字段为 null（从飞书记录无法还原），影响跨账号检查精度（低优先级，contentHash 已兜底）
- [ ] **c1Suspect 漏发风险**（2026-04-09 Codex 审计发现）：`publisher.js:1473` 网络异常+二次确认接口也挂时，返回 `success:true, c1Suspect:true`，scheduler 会把它写成"已发布"。如果原始 POST 实际上没到蚁小二，这条会被静默漏发且永不重试。**当年的设计权衡**是宁可漏发也不双发。修复方案：新增飞书状态 `待核验`，c1Suspect 路径只写"待核验"，调度器单独跑核验循环反复查 `/v2/taskSets`，命中改"已发布"，多次未命中改回"待发布"。涉及飞书字段配置变更和 scheduler 状态机分支，单独开 PR。

---

## ⚡ Echo 会话检查清单（每次任务完成前必查）

完成任何实质性改动后，**在报告完成之前**，按顺序检查：

1. **高风险改动**（发布逻辑 / 写库 / 防误操作 / 蚁小二发布链路）→ 冷眼审查（派独立子代理只看 diff + 需求）
2. **方向性问题**（项目定位、产品路线、架构主线；用户表达「要不要 / 像 A 还是像 B / 感觉但不确定」；或主会话准备列出 ≥2 个互斥方向）→ 先停下，说「这是方向性问题，建议三省讨论」
3. **有实质改动** → 建议写入 Obsidian changelog（`~/Obsidian/PersonalWiki/项目/知发/changelog/`）
4. **git push 前** → 脱敏扫描（绝对路径 / token / 邮箱 / AppID / 飞书 cli_xxx）
5. **规则文件改动** → 检查 rule-sync-matrix.yml 同步状态
