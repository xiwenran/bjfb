# 知发（bjfb）路线图

> 本文件记录知发项目所有阶段的规划与执行状态。
> 状态说明：✅ 已完成 / 🚧 进行中 / ⏸ 待启动
> 最后更新：2026-06-03（启动 v2.4 Skill 账号分组契约）

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
  3. 若 `xiaohongshuAccount` 和 `douyinAccount` 同时非空 → `{status: 'failed', reason: 'multiple_platform_accounts'}`，跳过；同一笔记发两个平台必须拆成两条记录
  4. 对唯一非空的平台账号计算指纹，调 `findRecordByFingerprint`
  5. 指纹已存在 → `{status: 'skipped', reason: 'fingerprint_exists', recordId}`
  6. 都通过 → `{status: 'pending'}`（占位，后续步骤填充）
  7. 本步暂时直接返回全部结果（AI 生成和写入结果为空）
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

---

## v2.1 — 素材导入页 UI 重做（🚧 进行中）

### 功能背景

v2.0 功能层面全部完成（P0-P4 ✅），但 UI 体验用户实测后明确不满：

- 批量账号设置挤在卡片里看不懂、分组逻辑难理解
- 时间分配只支持单时间点 + 固定间隔，无法配置多时段
- 右栏（min 620px）完全空置，所有设置挤在中栏
- 笔记序号按字典序排（10 排在 2 前面），不符合"自然序"直觉
- 整体 UI 被用户评为"糟糕透了"

### 设计原则（经圆桌三省讨论 + 用户确认）

**锁定共识**：
1. 废弃"批量设置模态弹窗"方向，所有操作做进中栏常驻 + 右栏详情（Airtable Grid + Expanded Record 模式）
2. 不做"批量 vs 单独"模式切换，用**渐进式联动**——默认自动分配好，单元格点改=批量，行点击进右栏=单条
3. **一篇笔记对一个账号**（业务规则：同平台多账号 = 重复发布违规），用单选下拉不是勾选矩阵
4. 右栏分层：空态=账号视角预演（每账号将收到哪些笔记），选中态=笔记大图+九宫格+表单

**用户确认的新增需求（2026-04-27）**：

- **时间窗口模式**（不是单时间点）：多个时间段 + 间隔分钟，自动按窗口顺序填槽位，超出当天容量顺延下一天
  - 例：`06:00-09:00 / 10:00-12:00 / 13:00-14:00 / 19:00-22:00`，间隔 30 分 → 一天 18 槽位
- **主题覆盖输入框**（"理解 B"）：文件夹名短（如 `春日穿搭`），软件里可以输入更详细的主题描述（如 `周末户外野餐 OOTD`）覆盖文件夹名传给 AI。文件夹名本身不改。
- **自然排序修复**：笔记序号 `1, 2, 3 ... 10, 11` 按自然序，已改 `server.js` 的 5 处 `localeCompare` 加 `{ numeric: true }`

### v2.1-A：自然排序修复

- **目标**：修复中英文数字混合排序，`10` 不再排在 `2` 前面
- **涉及文件**：`src/server.js`
- **改动**：5 处 `localeCompare` 加 `{ numeric: true }` 选项（账号名排序 / 主题目录 / 笔记子目录 / 图片文件名）
- **状态**：✅ 已完成（2026-04-27）

### v2.1-B：数据模型升级 + 主题覆盖字段

- **目标**：扩 `importGroupState` 加 `topicOverride` 字段（用户可选覆盖），扩 `importNoteState` 记 `dirty` 标记（用户单独改过不被批量覆盖）
- **涉及文件**：`public/index.html`（前端状态），`src/server.js`（create-records 接收 topicOverride 传给 AI）
- **实现要点**：
  - 组级：`{ topic: string (文件夹名), topicOverride: string (用户输入), channel, xhsAccounts, dyAccounts, timeWindows: [{start, end}], intervalMin, startDate }`
  - 笔记级：`{ noteKey, xhsAccount (单选), dyAccount (单选), publishTime, dirty, source }`
  - collect 阶段：`topicForAi = topicOverride || topic`
- **验收标准**：
  - 不填覆盖时，AI 用文件夹名生成内容（现状）
  - 填了覆盖时，AI 用覆盖内容生成
  - 单独改过账号/时间的笔记，批量操作不覆盖
- **状态**：✅ 已完成（2026-04-27，段 1 数据层 + topicOverride 字段已落地）

### v2.1-C：时间窗口算法 + UI

- **目标**：替换现有"起始日期 + 每天几条 + 时间点"的自动分配，改为多时段 + 间隔 + 自动顺延
- **涉及文件**：`public/index.html`
- **算法**：`allocateTimesByWindows(noteCount, windows, intervalMin, startDate)` → 时间戳数组
  - 按窗口顺序填槽，每窗内 `start + i*interval` 到 `> end` 换下一窗
  - 一天窗口填完 → 下一天同样窗口序列
- **UI**：中栏顶部时间窗口管理控件（可增减时段 + 全局间隔 + 起始日期 + 实时容量预览）
- **验收标准**：
  - 配 4 时段（06-09 / 10-12 / 13-14 / 19-22）间隔 30 分 = 22 槽/天（含端点），20 篇笔记一天内分配完
  - 手动改单条笔记时间不被批量覆盖（与 dirty 联动）
- **状态**：✅ 已完成（2026-04-27，段 3 时间窗口面板 + 算法接入）

### v2.1-D：中栏表格 + 列头批量

- **目标**：中栏从卡片/弹窗改为表格：每行一篇笔记（序号 + 缩略图 + 小红书下拉 + 抖音下拉 + 时间），列头点击=全选批量改该列
- **涉及文件**：`public/index.html`
- **候选账号池**：中栏顶部呈现"小红书池 / 抖音池"（用户勾选若干账号作为 round-robin 候选），表格里下拉选项只显示池内账号
- **批量动作**：
  - 🎲 重新 round-robin 分配账号
  - 🎲 按时间窗口重新分配时间
  - 列头点击 → 弹 mini 菜单"批量改为账号 X / 清空该列"
- **验收标准**：
  - 20 行笔记表格流畅滚动
  - 池内改动后，下拉选项同步更新
  - 列头批量只覆盖 `dirty=false` 的行
- **状态**：✅ 已完成（2026-04-27，段 2 中栏表格重写）

### v2.1-E：右栏双态（空态预演 / 选中态详情）

- **目标**：利用 620px 右栏
- **空态**（未选中笔记）：账号视角预演——每账号收到哪些笔记、什么时间发，让用户确认分配结果
- **选中态**（点某行笔记）：大图 380px + 右侧缩略图竖排 + 账号/时间/标题表单 + 上一篇/下一篇按钮
- **涉及文件**：`public/index.html`
- **状态变量**：`importSelectedNoteKey`（对标发布页 `selectedRecord`）
- **验收标准**：
  - 空态预演数据随中栏表格改动实时更新
  - 点表格行 → 右栏进入选中态，右栏改动回写中栏
- **状态**：✅ 已完成（2026-04-27，段 2 右栏空态/选中态联动）

### v2.1-F：主题覆盖 UI + 收尾

- **目标**：在账号池面板顶部加一个「覆盖主题描述」输入框，支持每个主题独立配；清理段 2 残留的旧时间分配函数和死按钮
- **涉及文件**：`public/index.html`、`docs/roadmap.md`
- **状态**：✅ 已完成（2026-04-27，段 3 主题覆盖输入框 + 死代码清理）
  - 删 `importContinueToTimeAllocation` 占位函数
  - 删 `importAutoDistributeTimes` 旧时间分配函数（引用已不存在的旧 DOM）
  - 删 `.import-table-continue` CSS 和 "继续到时间分配 →" 死按钮

### v2.1 执行顺序

```
v2.1-A (✅ 完成) → v2.1-B (数据模型) → v2.1-C + v2.1-D + v2.1-E 可部分并行 → v2.1-F (收尾)
```

每阶段完成后用户验收，不一把梭。

---

## v2.2 — 崩溃诊断持久化（🚧 进行中）

### v2.2-A：主进程 / 渲染进程 / 调度器统一落盘

- **目标**：下次知发再出现异常退出时，不再只剩 macOS `.ips`，而是能在知发自己的数据目录里直接看到：
  - 主进程致命异常
  - 渲染进程错误与资源加载失败
  - 崩溃前最后一段调度器状态、最近日志、当前发布进度
- **涉及文件**：`src/config-store.js`、`src/server.js`、`src/scheduler.js`、`src/electron-main.js`、`src/preload.js`、`public/index.html`
- **落盘文件**：
  - `~/Library/Caches/Zhifa/logs/runtime-diagnostics.ndjson`：追加式诊断事件流
  - `~/Library/Caches/Zhifa/logs/last-runtime-state.json`：最后一次运行状态快照
- **实现范围**：
  - `config-store.js` 统一提供诊断日志路径和原子写工具
  - `server.js` 在调度器日志 / 进度变更时同步刷新 `last-runtime-state.json`
  - `electron-main.js` 捕获 `uncaughtException`、`unhandledRejection`、`render-process-gone`、`did-fail-load` 等关键事件并追加写入 ndjson
  - `preload.js + index.html` 建立 renderer 错误上报通道，把 `error` / `unhandledrejection` / 资源加载失败写到主进程诊断日志
- **验收标准**：
  - 手动触发 renderer `throw new Error(...)` 后，`runtime-diagnostics.ndjson` 出现一条 `renderer-error`
  - 调度器运行中，`last-runtime-state.json` 能看到最近日志和当前进度
  - 下次应用异常退出后，至少能从知发数据目录定位“退前最后在做什么”和“哪一侧先报错”
- **状态**：🚧 进行中

---

## v2.3 — 分组目录导入与小红书标题规则（✅ 已完成，commit 157d137）

### 背景

用户希望降低素材整理成本，导入目录不再强制区分小红书/抖音或账号层级，而是按内容分组组织素材。平台、账号、发布日期和时间区间由知发在导入页强制补齐，缺失信息不得静默默认。

### 目录识别规则

```
导入根目录/
  教务资料/              ← 一级目录 = 内容分组
    笔记1/               ← 情况 A：二级目录就是一篇笔记
      0.jpg
      1.jpg
    某个主题PPT/          ← 情况 B：二级目录是 PPT 主题目录
      封面.jpg            ← 主题共享封面
      笔记1/
        1.jpg
      笔记2/
        1.jpg
```

- 一级目录作为 `accountGroup` / 内容分组，常见值：`教务资料`、`中考语法`、`综合类`
- 二级目录若直接包含图片且无有效笔记子目录，则按单篇笔记处理
- 二级目录若包含多个有效子目录，则作为 PPT 主题目录；三级目录是一篇笔记
- 主题目录下的 `0.jpg`、`封面.jpg`、`cover.jpg` 可作为共享封面；子笔记自带 `0.jpg` 时优先使用子笔记封面
- 若共享封面候选超过 1 张，不静默猜测，扫描结果提示用户处理

### 账号与排期

- 扫描目录不识别平台和账号
- 导入前必须让用户选择每个分组发布到哪些小红书/抖音账号；`中考语法` 默认不分配抖音
- 缺少发布日期或时间区间时，导入页必须阻止预览并让用户补齐
- 发布时间在用户选择的日期与时间区间内随机生成，避免固定间隔造成机械痕迹
- 排期需尽量错开同账号、同分组、同主题的集中发布

### 小红书标题规则

- 标题面向老师，16-20 字为主，最低 14 字，允许 1 个 emoji
- 标题必须包含具体教学/教务场景 + 情绪或结果钩子
- 禁止只介绍资料，如“这套课件很清楚/很省心”
- 优先参考真实小红书标题风格：场景冲突、反常识表达、课堂即时反馈、强节点压力、类比玩法钩子

### 涉及文件

- `src/server.js`：扩展 `/api/import/scan-folder` 返回分组、PPT 主题、共享封面来源
- `public/index.html`：导入页按内容分组补齐账号、日期、时间区间，预览随机排期
- `src/ai-writer.js`：AI 写作入参和 prompt 增加分组标题规则
- `docs/roadmap.md`：记录本期规划与状态

### 验收标准

- 能识别“一级分组 / 二级笔记”的旧结构
- 能识别“一级分组 / 二级 PPT 主题 / 三级笔记”的新结构
- 共享封面自动进入子笔记图片序列首位，子笔记自带封面时优先生效
- 未选择账号、日期或时间区间时不能进入 AI 预览
- 一键自动分配生成随机发布时间，不再呈现固定间隔
- AI 标题更接近小红书真实标题风格，并在预览中保留可编辑能力

---

## v2.4 — Skill 账号分组契约（🚧 进行中）

### 背景

v2.3 已经把应用导入目录改成“内容分组优先”，但 `zhifa-upload` 与 `zhifa-pipeline` Skill 仍以平台账号平铺清单为主。若不同步升级，Skill 在用户未明确指定账号时无法按 `教务资料`、`中考语法`、`综合类` 自动推荐账号池，也可能绕过“中考语法不自动发抖音”的业务边界。

### 设计原则

- 账号分组是发布策略，不进入素材目录结构，避免增加用户整理文件的工作量。
- 目录仍保持 `导入根目录 / 内容分组 / 笔记或PPT主题`。
- Skill 启动后读取 `accounts.json`，从一级内容分组匹配 `accountGroups` 推荐账号池。
- 用户消息里明确列出的账号优先级最高，可以覆盖 `accountGroups`。
- 未命中分组配置时，Skill 必须以选项形式追问，不得默认使用全部账号。
- `中考语法` / `语法` 分组默认 `douyinMode=manual`，不自动生成抖音记录。

### 涉及文件

- `skills/zhifa-upload/SKILL.md`
- `skills/zhifa-pipeline/SKILL.md`
- `skills/zhifa-pipeline/CHECKLIST-用户提需求模板.md`
- `docs/roadmap.md`

### 验收标准

- 两个 Skill 都说明 `accounts.json.accountGroups` 的推荐结构与优先级。
- Step 0 / CHECKLIST 不再只要求平台平铺账号，而是支持“分组账号规则”。
- 缺少分组账号信息时，Skill 必须强制追问要发布到哪些账号、日期和时间段。
- 明确说明账号分组不改变素材目录结构。
- 兼容旧版 `accounts.json` 平铺账号清单。

---

## v3.0 — 全链路 Claude Skill（PPT → 融景 → 知发）

> 状态：✅ 已完成（commit 6723314，2026-04-29）
> 目标：让用户一句话触发从 PPT 制作到飞书记录创建的完整链路，知发定时自动发布。

### 背景

v2.0 完成了「本地文件夹 → 飞书记录」的导入能力。v3.0 在此基础上，通过 Claude Code Skill 将上游的 PPT 转图片（ppt-batch-tool）和融景合成（rongjing）打通，形成三段全链路：

```
PPT → 图片（ppt-batch-tool）→ 融景合成笔记图（rongjing）→ 飞书记录（知发）→ 定时发布
```

### 封面图约定

每篇笔记的文件夹内，封面命名为 `0.jpg`。文件名排序保证封面永远第一（0 < 1 < 2 …）。

Skill 接收用户 @ 引用的任意文件名封面图，自动重命名为 `0.jpg` 放入对应文件夹，用户无需手动改名。

### 两个层级的 Skill

**层级一：上传层**（已有融景合成图，直接上传知发）

用户一次性提供：
- 融景合成图所在目录
- 各组封面（@ 引用，任意文件名）
- 各组笔记主题（一句话描述）
- 发布时间安排

**层级二：全链路**（从 PPT 开始，全程自动）

用户一次性提供：
- PPT 文件夹
- 各 PPT 对应封面（@ 引用）
- 各 PPT 笔记主题
- 发布时间安排

输入格式示例（支持多组）：

```
PPT文件夹：/path/to/PPTs/
输出目录：/path/to/output/
小红书账号：xxx

【笔记1】草船借箭第一课时
封面：@草船借箭封面.jpg
发布时间：明天 9:00

【笔记2】五年级期中家长会
封面：@家长会封面设计稿.png
发布时间：后天 15:00
```

### 文案生成策略

- **优先**：Claude（当前会话模型）根据笔记主题生成标题/正文/标签，展示给用户确认
- **兜底**：Claude 生成失败时，传空 title → 知发走 `topicOverride` + 自身 AI 配置兜底
- 用户在确认环节可逐条修改，无需全部重新生成

### 用户交互节点

整条链路只有一次用户交互：**审阅 Claude 生成的文案**

其余步骤（PPT 转图、融景合成、封面放置、飞书记录创建）全部自动执行。

### 接口对接

复用 v2.0 已有接口：
- `GET /api/import/preflight`：检查飞书字段是否齐全
- `POST /api/import/scan-folder`：扫描文件夹，返回识别结果
- `POST /api/import/create-records`：预填 title/description/tags，跳过知发自身 AI

### 状态

- [x] 上传层 Skill（`~/zhifa/skills/zhifa-upload/SKILL.md`，软链接 `~/.claude/skills/zhifa-upload`）
- [x] 全链路 Skill（`~/zhifa/skills/zhifa-pipeline/SKILL.md`，软链接 `~/.claude/skills/zhifa-pipeline`）
- [x] 辅助脚本（`~/zhifa/scripts/skill_upload.py`，封装 scan-folder / create-records API）
- [x] 封面 cp 为 `0.jpg`（SKILL.md 里告知 Claude 直接用 cp 命令）
- [x] Claude 文案生成 + 预览确认环节
- [x] 多组批量匹配（封面 + 主题 + 时间对应关系）
- [x] 冷眼审查 + 修复（@ 附件路径、scan JSON 临时文件、xiaohongshuChannel 字段等问题）

Skill 遵循「属于谁就归谁管」原则：SKILL.md 住在 zhifa 项目仓库里，`~/.claude/skills/` 下是软链接。
