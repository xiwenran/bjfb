# 知发（bjfb）路线图

> 本文件记录知发项目所有阶段的规划与执行状态。
> 状态说明：✅ 已完成 / 🚧 进行中 / ⏸ 待启动
> 最后更新：2026-04-24（v2.0 规划经冷眼审查 + 技术审查修订）

---

## 已完成功能（v1.3.0 基线）

- 飞书多维表格驱动 + 定时/补发/单条发布
- 双模式发布引擎（蚁小二 + 比特浏览器）
- 三层红线防重复（C1 + R6 + 血统账本）
- AI 写作模块（调度器后台检测路径）
- 三栏 SPA 前端（总览 / 发布 / 数据 / 设置）

---

## v2.0 — 素材导入 + 主题撰写功能

### 功能背景

用户希望在知发内直接完成素材录入，不再手动打开飞书表格建行。核心变化：

- 本地文件夹（一级目录=主题，二级子文件夹=一篇笔记）直接导入
- AI 写作在导入时直接调用，不走调度器的 24h 检测路径
- 飞书记录一落地即完整（标题/正文/标签/图片/账号/时间/状态全部写入）
- 调度器继续负责定时发布，不动

### 目录结构规则

```
导入根目录/
  主题A/              ← 一级目录 = topic（直接传给 AI）
    1/                ← 二级子文件夹 = 一篇笔记，按文件名字典序升序排列
      1.jpg
      2.jpg
    2/
      1.jpg
  主题B/
    1/
      cover.jpg
```

- 图片按**文件名字典序升序**决定顺序和封面（第一张为封面）
- 只识别两级，不递归；只支持图片（`.jpg .jpeg .png .webp .gif`）
- 视频文件（`.mp4 .mov` 等）**v2.0 不支持**，扫描时标记警告但不中断

### 接口设计说明（P0 阶段确定，影响 P3）

`POST /api/import/create-records` 支持 `dryRun` 参数：

- `dryRun: true`：只做 AI 生成，不上传图片、不建飞书记录，返回生成内容供预览
- `dryRun: false`（默认）：完整链路，上传图片 + 建飞书记录

P3.0 用 dryRun 模式，P3.1 用完整模式，共用同一个接口。

---

## P0 — 后端基础能力

> 目标：在没有前端的情况下，通过 Postman / 脚本可以跑通完整的"建飞书记录"链路。
> P0.0-X / P0.0-A / P0.0-B / P0.0-C / P0.1-A 互相独立，可并行执行。
> P0.1-B-1/B-2/B-3 串行，依赖 P0.0 全部完成。

---

### P0.0-X：Preflight 检查接口

- **目标**：`src/server.js` 新增 `GET /api/import/preflight`，调飞书 API 检查多维表格是否存在所有导入必需字段，缺少时返回字段名单
- **涉及文件**：`src/server.js`、`src/feishu.js`（新增 `getTableFields()` 方法，调飞书 `GET .../fields` 接口）
- **必需字段清单**（硬编码）：笔记主题、标题、正文、标签、素材、内容类型、发布时间、小红书账号、小红书发布状态、抖音账号、抖音发布状态、导入指纹
- **返回格式**：
  ```json
  { "ok": true }
  // 或
  { "ok": false, "missingFields": ["导入指纹", "素材"] }
  ```
- **前端使用**：进入导入页面时先调此接口，`ok: false` 时展示缺失字段列表和操作指引，不展示扫描入口
- **验收标准**：
  - 表格字段齐全时返回 `{"ok": true}`
  - 缺少"导入指纹"字段时返回 `{"ok": false, "missingFields": ["导入指纹"]}`
  - 飞书 API 调用失败时返回 500 + 错误信息
- **状态**：✅ 已完成

---

### P0.0-A：飞书新建记录封装

- **目标**：`src/feishu.js` 新增 `createRecord(fields)` 方法，调用飞书 `POST /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records`
- **涉及文件**：`src/feishu.js`
- **字段清单**（与现有 parseRecord 字段名保持一致）：
  - 笔记主题、标题、正文、标签（多行文本，`\n` 分隔）
  - 素材（附件字段，格式 `[{"file_token": "xxx"}]`）
  - 内容类型（固定值 `"图文"`）
  - 发布时间（时间戳毫秒数，为空则不传此字段）
  - 小红书账号、小红书发布状态（选了账号则传 `"待发布"`，否则不传）
  - 抖音账号、抖音发布状态（同上）
  - 导入指纹（文本，SHA256 字符串）
- 小红书发布渠道（单选，`蚁小二` 或 `比特浏览器`，选了小红书账号才写）
- **返回值**：`{ recordId: string }` —— 从飞书响应 `data.record.record_id` 取
- **验收标准**：
  - `createRecord({ 笔记主题: '主题A', 标题: '测试' })` 调用后，飞书表格出现一条新记录
  - 返回的 `recordId` 非空字符串，可用于后续 `getRecordById` 查询
  - 只传部分字段时不报错（未传字段飞书侧留空）
- **状态**：✅ 已完成

---

### P0.0-B：本地图片上传到飞书附件字段

- **目标**：`src/feishu.js` 新增 `uploadLocalImagesToFeishu(imagePaths)` 方法，将本地图片上传为飞书附件，返回 file_token 列表
- **涉及文件**：`src/feishu.js`、`package.json`（确认或新增 `form-data` 依赖）
- **实现要点**：
  - 飞书文件上传 API：`POST /open-apis/drive/v1/medias/upload_all`，需要 `multipart/form-data`
  - 参数：`parent_type: "bitable_file"`、`parent_node: appToken`（需查飞书文档确认 bitable_file 的正确 parent_node 值）
  - 现有代码全是 JSON 请求，multipart 需要引入 `form-data` 包；先检查 `package.json` 是否已有，没有则 `npm install form-data`
  - 上传前给文件名加 `crypto.randomBytes(6).toString('hex') + '_'` 前缀，防止同名文件在飞书侧覆盖（参考 2026-04-09 OSS 覆盖事故）
  - 按传入的 `imagePaths` 数组顺序上传，保证附件顺序 = 图片顺序（图片已按文件名排序后传入）
  - 每张图上传后立即拿到 file_token，不使用临时目录（直接 `fs.readFileSync` 读入内存）
- **返回值**：`[{ originalName: string, fileToken: string }]`
- **验收标准**：
  - 传入 3 张本地图片路径，用 `createRecord` 写入飞书，查询该记录的素材附件字段，`file_token` 数量等于 3
  - 同名图片（两个子文件夹都有 `1.jpg`）分别上传，飞书侧 `file_token` 不同（互不覆盖）
  - 传入不存在的路径，抛出明确错误信息，不返回空 token
- **状态**：✅ 已完成

---

### P0.0-C：导入指纹查重

- **目标**：`src/feishu.js` 新增 `findRecordByFingerprint(fingerprint)` 方法，按导入指纹字段查询飞书记录是否已存在
- **涉及文件**：`src/feishu.js`
- **指纹生成规则**（统一在 server.js 的 helper 函数里实现，feishu.js 只做查询）：
  ```
  SHA256(
    一级目录名 + '|' +
    二级目录名 + '|' +
    平台('xiaohongshu'或'douyin') + '|' +
    账号名 + '|' +
    图片文件名列表.sort().join(',') + '|' +
    图片文件大小列表（按文件名排序后对应）.join(',')
  )
  ```
- **飞书字段名**：`导入指纹`（用户需在飞书表格手动新增此文本字段，P0.0-X 的 preflight 会检查）
- **查询方式**：调用现有 `getRecords` 并传 filter 条件（`conjunctions: "and", conditions: [{field_name: "导入指纹", operator: "is", value: [fingerprint]}]`）
- **返回值**：命中返回 `record_id` 字符串，未命中返回 `null`
- **验收标准**：
  - 查询一个不存在的指纹，返回 `null`
  - 用 `createRecord` 建一条含指纹的记录后，再查同一指纹，返回对应 `record_id`
- **局限性说明**（写进代码注释）：指纹基于文件名+大小，文件内容改变但文件名和大小不变时不会触发重新导入，用户需手动删除飞书记录或更改文件名
- **状态**：✅ 已完成

---

### P0.1-A：扫描目录 API

- **目标**：`src/server.js` 新增 `POST /api/import/scan-folder`，接收本地绝对路径，返回两级目录结构
- **涉及文件**：`src/server.js`
- **返回结构**：
  ```json
  [
    {
      "topic": "主题A",
      "notes": [
        {
          "noteKey": "主题A/1",
          "folderName": "1",
          "folderPath": "/absolute/path/主题A/1",
          "images": [
            { "name": "1.jpg", "path": "/absolute/path/主题A/1/1.jpg", "size": 102400 }
          ],
          "imageCount": 2,
          "firstImagePath": "/absolute/path/主题A/1/1.jpg",
          "hasVideo": false,
          "warnings": []
        }
      ]
    }
  ]
  ```
- **排序规则**：
  - 一级目录（主题）：文件名字典序升序
  - 二级子文件夹：文件名字典序升序
  - 每个子文件夹内图片：文件名字典序升序
- **过滤与标记规则**：
  - 跳过以 `.` 开头的隐藏文件/文件夹
  - 只识别两级，第三级及更深层忽略
  - 有效图片格式（大小写不敏感）：`.jpg .jpeg .png .webp .gif`
  - 视频文件（`.mp4 .mov .avi`）：不报错，在 `warnings` 里加 `"包含视频文件（v2.0 不支持，已跳过）"`
  - 无有效图片的子文件夹：`imageCount: 0`，`warnings` 加 `"无有效图片"`，仍返回此条（前端展示警告）
- **验收标准**：
  - 正常目录：返回正确的 JSON 结构，图片和子文件夹均按字典序排列
  - 目录不存在：返回 `400` + `{"error": "目录不存在: /path"}`
  - 空目录（无子文件夹）：返回空数组 `[]`
  - 只有一级（无二级子文件夹）：对应主题的 `notes` 为 `[]`
  - 有视频文件的子文件夹：该 note 的 `warnings` 包含视频提示，`imageCount` 不计入视频
  - 三级嵌套目录：第三级不出现在结果中
- **状态**：✅ 已完成

---

### P0.1-B-1：建单 API 框架 + 账号校验 + 指纹查重

- **目标**：`src/server.js` 新增 `POST /api/import/create-records` 路由骨架，实现账号校验和指纹查重两步，暂不调 AI 和飞书写入
- **涉及文件**：`src/server.js`（新增路由 + `buildImportFingerprint` helper 函数）
- **请求体结构**：
  ```json
  {
    "dryRun": false,
    "records": [
      {
        "topic": "主题A",
        "noteKey": "主题A/1",
        "folderPath": "/absolute/path/主题A/1",
        "images": [{ "name": "1.jpg", "path": "...", "size": 102400 }],
        "xiaohongshuAccount": "账号A",
        "douyinAccount": "",
        "publishTime": "2026-04-25 10:00",
        "title": "",
        "description": "",
        "tags": []
      }
    ]
  }
  ```
- **本步执行逻辑**：
  1. 遍历 records，每条：
  2. 若 `xiaohongshuAccount` 和 `douyinAccount` 均为空 → `{status: 'failed', reason: 'no_account'}`，跳过
  3. 对每个非空平台账号，计算指纹，调 `findRecordByFingerprint`
  4. 指纹已存在 → `{status: 'skipped', reason: 'fingerprint_exists', recordId}`
  5. 都通过 → `{status: 'pending'}`（占位，后续步骤填充）
  6. 本步暂时直接返回全部结果（AI 生成和写入结果为空）
- **验收标准**：
  - 传入无账号的记录，返回 `failed/no_account`
  - 传入已存在指纹的记录，返回 `skipped/fingerprint_exists`
  - 传入有效记录，返回 `pending`（还没有 AI 内容）
- **状态**：✅ 已完成

---

### P0.1-B-2：AI 生成集成

- **目标**：在 P0.1-B-1 的骨架里，为 `status: 'pending'` 的记录调用 `generateContent`，拿到标题/正文/标签
- **涉及文件**：`src/server.js`（调用 `src/ai-writer.js`）
- **关键技术点**：
  - `generateContent` 的**正确签名**是 `generateContent(aiConfig, record)`，其中 `aiConfig` 从 `config.aiWriting` 读取，`record` 是含 `{topic, attachments: [{name}], xiaohongshuAccount, douyinAccount}` 的对象（attachments 此时只有文件名，无 file_token，但 `buildUserMessage` 只用 `.name`，可行）
  - 若请求体里 `title` 非空，跳过 AI 生成，直接用用户传入的值（预览后编辑的场景）
  - `dryRun: true` 时：AI 生成完成后**直接返回**，不进入下一步（上传/建单）
  - AI 配置未启用（`config.aiWriting.enabled === false`）时：`title/description/tags` 留空，不报错，继续建单
- **AI 调用失败时**：记录标为 `{status: 'failed', reason: 'ai_error', message}`，**不进入上传/建单步骤**
- **验收标准**：
  - `dryRun: true` 时返回 AI 生成的 `title/description/tags`，飞书无新记录
  - `dryRun: false` 且 AI 成功时，title 字段有值，进入 B-3
  - `dryRun: false` 且 AI 失败时，返回 `failed/ai_error`，飞书无新记录
  - 请求体里已有 `title` 时，AI 不被调用（通过 log 确认无 AI 请求发出）
- **状态**：✅ 已完成

---

### P0.1-B-3：图片上传 + 飞书建单

- **目标**：在 B-2 完成 AI 生成后，上传图片到飞书并创建完整记录（仅 `dryRun: false` 时执行）
- **涉及文件**：`src/server.js`（调用 `src/feishu.js` 的 `uploadLocalImagesToFeishu` 和 `createRecord`）
- **执行逻辑**：
  1. 调 `uploadLocalImagesToFeishu(record.images.map(i => i.path))`
  2. 上传失败 → `{status: 'failed', reason: 'upload_error', message}`，不建记录
  3. 组装 fields 对象（AI 内容 + file_token 列表 + 账号 + 时间 + 状态 + 指纹）
  4. 调 `createRecord(fields)`
  5. 建单失败 → `{status: 'failed', reason: 'feishu_error', message}`
  6. 成功 → `{status: 'success', recordId}`
  7. 通过 SSE（`/api/logs/stream`）推进度事件：`{ type: 'import_progress', current: N, total: M, noteKey, status }`
- **字段组装规则**：
  - 选了小红书账号：写 `小红书账号` + `小红书发布状态: '待发布'` + `小红书发布渠道`（用户选择的值，蚁小二或比特浏览器）
  - 未选小红书：三个字段均不传
  - 选了抖音账号：写 `抖音账号` + `抖音发布状态: '待发布'`（抖音无渠道字段）
  - 未选抖音：两个字段均不传
  - 发布时间为空：不传发布时间字段（用户后续在飞书或发布页手动设置）
  - 内容类型：固定 `'图文'`
- **验收标准**：
  - 传入 1 条有效记录（含小红书账号），飞书出现 1 条完整记录：含 AI 标题/正文/标签、图片附件、账号、发布状态"待发布"、导入指纹
  - 图片上传失败时，飞书无新记录，返回 `failed/upload_error`
  - SSE 推送的 `import_progress` 事件中 `current` 随每条处理完成递增
- **状态**：✅ 已完成

---

### P0.2：isMasterPublisher 配置项

- **目标**：`src/config-store.js` 的 `DEFAULT_CONFIG` 加入 `isMasterPublisher: true`；`src/scheduler.js` 的 `start()` 方法在启动前检查此配置，为 `false` 时直接返回并 log
- **涉及文件**：`src/config-store.js`、`src/scheduler.js`
- **默认值说明**：`true` 保证现有用户升级后行为不变
- **注意**：此任务只做后端逻辑，UI 开关在 P4.0 实现
- **验收标准**：
  - 修改 config.json 将 `isMasterPublisher` 设为 `false` 后，`POST /api/scheduler/start` 不启动调度器，log 里出现"非发布主机，调度器不启动"
  - config.json 无此字段（旧用户）时，`deepMerge` 后 `config.isMasterPublisher === true`，调度器正常启动
- **状态**：✅ 已完成

---

## P1 — 前端导入页面骨架

---

### P1.0：导航新增"素材导入"入口

- **目标**：`primary-rail` 顶部组新增"素材导入"图标按钮（📁），放在 📤发布 下方；`switchSection('import')` 切换到导入页占位区域
- **涉及文件**：`public/index.html`
- **验收标准**：
  - 点击图标切换到导入页（空白区域即可），图标高亮
  - 切换回其他页面后导入页不渲染，无 JS 报错
- **状态**：✅ 已完成

---

### P1.1-A：Electron Preload 脚本（文件夹选择前置）

- **目标**：新建 `src/preload.js`，通过 `contextBridge` 将文件夹选择能力暴露给前端；在 `electron-main.js` 的 `createMainWindow` webPreferences 里加入 `preload` 路径；注册 `ipcMain.handle('dialog:openFolder', ...)`
- **涉及文件**：`src/preload.js`（新建）、`src/electron-main.js`
- **实现内容**：
  ```js
  // preload.js
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('electronAPI', {
    openFolder: () => ipcRenderer.invoke('dialog:openFolder')
  });

  // electron-main.js ipcMain.handle
  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ```
- **验收标准**：
  - Electron 环境下，前端调用 `window.electronAPI.openFolder()` 弹出系统文件夹选择对话框
  - 用户选择文件夹后返回绝对路径字符串；取消则返回 `null`
  - `contextIsolation: true` 保持不变（安全要求）
- **状态**：✅ 已完成

---

### P1.1-B：文件夹选择 + 扫描结果展示

- **目标**：导入页显示"选择根目录"按钮，调用 `window.electronAPI.openFolder()` 取得路径，再调 `/api/import/scan-folder`，按主题分组渲染子文件夹卡片
- **涉及文件**：`public/index.html`
- **渲染结构**：
  - 顶部显示当前选择的目录路径（让用户确认）
  - 中栏：按主题分组，每组可折叠/展开，默认展开
  - 每张子文件夹卡片：第一张图缩略图（`<img>` 用 `file://` 路径）+ 文件夹名 + 图片数量
  - `imageCount: 0` 的卡片：显示 ⚠️ 无有效图片，灰色禁用状态
  - 有 `warnings` 的卡片：显示 ⚠️ 图标，hover 展示警告内容
  - 目录内无任何有效子文件夹：显示"未发现可导入的笔记素材"提示
- **验收标准**：
  - 选择有效根目录后，中栏按主题分组渲染卡片，顺序与 API 返回一致（字典序）
  - 重新选择目录后，旧结果清空，显示新结果
  - 无有效子文件夹时显示空状态提示，不显示空列表
  - 有视频文件的卡片显示警告图标
- **状态**：✅ 已完成

---

## P2 — 账号选择 + 时间分配

---

### P2.0：账号选择 UI

- **目标**：每张子文件夹卡片内加小红书账号 + 发布渠道 + 抖音账号三个下拉；主题级批量操作栏
- **涉及文件**：`public/index.html`
- **账号数据来源**：`GET /api/accounts`（现有接口），**只展示状态正常的账号**（过滤掉 status 非正常的账号）
- **卡片内字段布局**：
  - 小红书账号下拉（选项来自 /api/accounts 小红书账号列表）
  - 小红书发布渠道下拉（固定两个选项：`蚁小二` / `比特浏览器`，默认 `蚁小二`）——**仅当选了小红书账号后才显示**，未选账号时渠道下拉隐藏
  - 抖音账号下拉（选项来自 /api/accounts 抖音账号列表）；抖音无渠道选择，固定蚁小二
- **批量设置规则**：每个主题组顶部有"批量设置"行：
  - 小红书批量：账号下拉 + 渠道下拉，点应用后只覆盖当前主题下小红书账号为空的卡片
  - 抖音批量：只有账号下拉，点应用后只覆盖抖音账号为空的卡片
  - 已单独选过的卡片不覆盖（防止误操作）
- **验收标准**：
  - 账号下拉列表只显示状态正常的账号
  - 未选小红书账号时，发布渠道下拉不显示
  - 选了小红书账号后，发布渠道下拉出现，默认选中"蚁小二"
  - 批量设置后，空账号卡片同步更新（账号+渠道一起同步），已填卡片不变
  - `imageCount: 0` 的禁用卡片不参与批量设置
- **状态**：✅ 已完成

---

### P2.1：发布时间分配 UI

- **目标**：顶部"自动分配"区 + 每张卡片单独时间输入框
- **涉及文件**：`public/index.html`
- **自动分配参数**（全局，不分主题）：
  - 起始日期（日期选择器，默认明天）
  - 每天最多几条（数字输入，默认 2）
  - 发布时间点（时间选择器，默认 10:00）
- **自动分配逻辑**（纯前端计算）：
  - 按页面卡片顺序（主题字典序 → 子文件夹字典序）对所有有效卡片（`imageCount > 0`）排列
  - 同一天填满"每天最多几条"后，下一条顺延到下一天的相同时间
  - 计算结果写入各卡片时间输入框，格式 `YYYY-MM-DD HH:mm`
- **验收标准**：
  - 点"应用到全部"后，各卡片时间按字典序排列，同一天内不超过设定条数
  - 手动修改单张卡片时间后，其他卡片时间不变
  - 时间输入框留空的卡片：导入后记录"发布时间"字段为空，调度器扫到"待发布"状态后立即处理（现有调度逻辑已支持）
- **状态**：✅ 已完成

---

## P3 — AI 写作预览 + 导入执行 + 报告

---

### P3.0：主题撰写 → AI 预览界面

- **目标**：点击"主题撰写并预览"后，以 `dryRun: true` 调用 `/api/import/create-records`，在右栏展示 AI 生成内容预览（不写飞书）
- **涉及文件**：`public/index.html`
- **预览界面结构**：
  - 每条记录一张预览卡（noteKey + 平台 + 账号名作为标题）
  - 展示 AI 生成的标题（`<input>` 可编辑）、正文（`<textarea>` 可编辑，默认收起）、标签列表（只读展示）
  - AI 失败的卡片：红色边框，显示失败原因，提供两个选项：**"跳过此条"**（不导入）/ **"空建"**（不填内容，建飞书记录后用户手动填）
  - 底部"确认导入"按钮，disabled 状态直到预览加载完成
- **按钮状态**：点击后显示 loading，完成后切换到"确认导入"
- **验收标准**：
  - 预览卡正确展示 AI 生成内容，标题/正文可编辑
  - AI 失败卡片显示红色警告和两个选项
  - 飞书表格无新记录（dryRun 验证）
- **状态**：✅ 已完成

---

### P3.1：预览确认 → 写入飞书

- **目标**：用户点"确认导入"，携带编辑后内容以 `dryRun: false` 调用完整建单链路
- **涉及文件**：`public/index.html`
- **请求组装规则**：
  - 将预览卡里用户编辑过的 `title/description/tags` 回填到请求体（后端检测到 title 非空则跳过 AI 生成）
  - "跳过此条"的记录从请求体里移除
  - "空建"的记录 `title/description/tags` 传空字符串/空数组，后端 AI 配置未启用时留空建单
- **交互设计**：
  - 按钮点击后变 loading + disabled，不可重复点击
  - 监听 SSE 的 `import_progress` 事件，显示"正在导入第 X / N 条"文字进度
- **验收标准**：
  - 确认后飞书出现完整记录，编辑过的标题/正文正确写入（非 AI 原始值）
  - 已标记"跳过"的记录不出现在飞书
  - "空建"的记录在飞书有对应行但标题/正文为空
- **状态**：✅ 已完成

---

### P3.2：导入报告

- **目标**：导入完成后，右栏切换为导入报告视图
- **涉及文件**：`public/index.html`
- **报告格式**：
  - 顶部汇总：`X 条成功 / Y 条跳过 / Z 条失败`
  - 逐条展示：✅ 成功（附 recordId 缩短显示）/ ⏭ 跳过（已存在相同记录）/ ❌ 失败（类型 + 简短原因）
  - 失败条点击展开完整错误信息
  - "关闭报告"按钮，点击后重置页面状态（清空扫描结果、预览、时间选择），可继续新一轮导入
- **验收标准**：
  - 报告条目数 = 请求里的 records 总条数（跳过的也要显示）
  - 关闭后页面状态完全重置，不残留上一轮数据
- **状态**：✅ 已完成

---

## P4 — 体验完善

> P4.0（发布主机 UI）与其他任务无依赖，可提前与 P1/P2 并行执行。

---

### P4.0：发布主机开关 UI

- **目标**：设置页新增"此设备为发布主机"开关，读写 `config.isMasterPublisher`（后端逻辑在 P0.2 已完成）
- **涉及文件**：`public/index.html`（设置页 UI）、`src/server.js`（`GET/POST /api/config` 已支持，无需改动）
- **位置**：设置页"调度"子页，放在调度器启动/停止按钮附近
- **说明文案**：`"开启后此设备将自动运行定时发布；关闭后此设备只用于素材导入，不参与发布"`
- **验收标准**：
  - 开关状态与 config.json 的 `isMasterPublisher` 同步
  - 关闭后重启应用，调度器不自动启动，设置页开关仍为关闭状态
- **状态**：✅ 已完成

---

### P4.1：导入实时进度条

- **目标**：批量导入过程中，在确认导入按钮下方显示实时进度（第 X / N 条 · 当前步骤）
- **涉及文件**：`public/index.html`
- **实现方式**：监听 SSE `/api/logs/stream` 的 `import_progress` 事件（P0.1-B-3 已推送），自定义事件 type 名不与现有 `progress` 事件冲突
- **验收标准**：
  - 导入 3 条以上记录时，进度数字实时更新，当前 noteKey 显示在进度条旁
  - 导入完成后进度消失，切换到报告视图
- **状态**：✅ 已完成

---

### P4.2-A：更新已有记录 — 交互流程

- **目标**：当指纹命中时（API 返回 `skipped/fingerprint_exists`），导入报告的跳过条上显示"覆盖旧记录"按钮；点击后弹出确认对话框
- **涉及文件**：`public/index.html`
- **对话框内容**：
  - 默认情况：`"确认用新内容覆盖这条记录吗？旧记录的内容和图片将被替换。"`
  - 旧记录已发布时（从 API 返回的 `existingStatus` 判断）：额外加警告 `"⚠️ 此记录已标记为「已发布」，覆盖后状态将重置为「待发布」，调度器可能重新发布此内容。请确认后操作。"`
- **验收标准**：
  - 跳过条显示"覆盖"按钮
  - 已发布记录弹出包含警告的对话框
  - 用户取消：对话框关闭，记录保持跳过状态
  - 用户确认：调用 P4.2-B 的覆盖接口
- **状态**：✅ 已完成（P4.2-A + P4.2-B 同批次完成）

---

### P4.2-B：更新已有记录 — 后端实现

- **目标**：`src/server.js` 在 create-records 路由里新增覆盖逻辑；`src/feishu.js` 确认 `updateRecord` 对附件字段的覆盖写入行为
- **涉及文件**：`src/server.js`、`src/feishu.js`
- **实现要点**：
  - 前端传 `{overwrite: true, overwriteId: 'xxx'}` 时，跳过指纹查重，直接进入上传+更新流程
  - 调用现有 `updateRecord(recordId, fields)` 传入新 file_token 列表
  - 状态重置为 `待发布`；fingerprintExists 路径新增 `existingStatus` 字段（从 `getRecordById` 读取）
- **验收标准**：
  - 覆盖后飞书记录内容、图片、状态均更新
  - 覆盖前后同一 `record_id`（不是新建记录）
- **状态**：✅ 已完成

---

## 执行顺序

```
① P0.0-X / P0.0-A / P0.0-B / P0.0-C / P0.1-A / P0.2  ← 全部并行
                    ↓
② P0.1-B-1  ← 依赖 P0.0-A/B/C 完成
                    ↓
③ P0.1-B-2  ← 依赖 B-1
                    ↓
④ P0.1-B-3  ← 依赖 B-2
                    ↓（P1 骨架可与 P0 并行启动）
⑤ P1.0 / P1.1-A   ← 可与 P0 并行（纯前端骨架 / Electron preload）
                    ↓
⑥ P1.1-B    ← 依赖 P1.1-A + P0.1-A
                    ↓
⑦ P2.0 / P2.1    ← 依赖 P1.1-B
                    ↓
⑧ P3.0 / P3.1 / P3.2  ← 依赖 P0.1-B-3 + P2 全部完成
                    ↓
⑨ P4.0 / P4.1 / P4.2-A / P4.2-B  ← 体验增强，按需先后执行
   （P4.0 可提前与 P1/P2 并行）
```

**MVP = P0 + P1 + P2 + P3**（共 13 个子任务）
**完整版 = MVP + P4**（共 17 个子任务）
