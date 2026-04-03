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
| `checkAndPublish()` | 扫描飞书，补建精准任务；内部完整 try/catch，永不抛出 |
| `publishRecords(records, reason)` | 实际发布；支持队列并发、停止后不再继续吃后续排队任务 |
| `publishSpecificRecord(recordId)` | 立即发布指定记录，先取消该记录定时任务；仅处理平台状态为 `待发布` 的记录 |
| `scheduleRecordTask(record, time)` | 创建精准定时器，async 回调包裹在 `.catch()` 中 |
| `getScheduledTasks()` | 返回当前所有定时任务（含 `remainingMs`），供前端倒计时显示 |

### 近期稳定性修复（2026-04-02）

- 修复账号自动映射：刷新账号状态或发布前，会用飞书账号名匹配蚁小二账号名/别名，只有唯一精确匹配时才自动回写映射
- 修复发布并发：支持同一时间多条记录并发处理，默认 `rules.publishRecordConcurrency = 2`
- 修复重复发布回归：新增发布账本保护和最近成功记录保护，避免飞书状态回写延迟时同一条被重复提交
- 调整云发布状态：蚁小二云发布提交成功后先写为 `发布中`，不再直接写成 `已发布`
- 强化红线规则：自动调度、顶部“立即补发”、单条“立即发布”都只允许处理平台状态精确等于 `待发布` 的记录，`发布失败` 必须先人工改回 `待发布`
- 调整停止行为：点击停止后，只允许当前正在发布的记录收尾，后续排队和未开始的定时任务暂停
- 调整顶部按钮文案：总览页顶部按钮改为“立即补发”，表示只补发当前已到时间的内容，不会把未来定时任务全部发出

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
- **导航**：无文字标签，只有 emoji 图标（🏠📤⚙️📊），激活时绿色背景
- **卡片**：`box-shadow` 提供层次感，hover 有 `translateY(-1px) scale(1.005)`
- **选中记录**：左侧绿色 border `border-left: 3px solid var(--accent)`
- **工具栏**：2-column grid，左边标题，右边 pills + 按钮，不能改成竖排

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

---

## 待办 / 潜在优化点

- [ ] SSE 重连目前无限循环，Electron 本地环境可接受，若需限制可加最大次数
- [ ] 音乐库状态 `musicLibraryState` 多个异步函数共享，极端情况可能竞态
- [ ] `refreshRecords()` 等 Promise 调用方未 await，失败时 UI 静默不同步（低优先级）
