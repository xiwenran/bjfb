# 笔记发布工具

飞书多维表格驱动的自动发布项目：

- 小红书支持两种渠道：
  - 蚁小二（API 云发布 / 本机发布）
  - 比特浏览器（Playwright 模拟真人操作）
- 抖音固定走蚁小二

---

## 快速开始

1. 安装依赖：

```bash
npm install
```

2. 启动服务：

```bash
npm start
```

3. 首次启动时，程序会在当前系统用户目录自动生成空白配置模板
4. 打开 [http://localhost:3210](http://localhost:3210)，进入“飞书接入”页填写配置
5. `config.example.json` 仅作为字段结构参考，不再要求复制到项目根目录

如需启动桌面壳（Electron）：

```bash
npm run desktop
```

桌面版会自动拉起内置本地服务并加载同一套管理界面。

如需本地生成 Windows 安装包：

```bash
npm run dist:win
```

如需本地生成 macOS 分发包：

```bash
npm run dist:mac
```

当前分发方式：

- Windows：`NotePublisher Portable.exe`，免安装，可直接运行
- macOS：`NotePublisher macOS.zip`，解压后直接打开 `.app`

两者都会继续把配置和运行数据放在系统用户目录，因此删掉程序文件本体后，本机配置默认仍会保留。

仓库内已提供 GitHub Actions 工作流，会在推送后自动构建 Windows 与 macOS 两套产物并上传为构建产物。

---

## 配置与数据目录

程序实际读写的本机数据不再放在项目根目录，而是放在当前系统用户目录：

- Windows 配置目录：`%AppData%/NotePublisher/config.json`
- Windows 数据目录：`%LocalAppData%/NotePublisher/`
- macOS 配置目录：`~/Library/Application Support/NotePublisher/config.json`
- macOS 数据目录：`~/Library/Caches/NotePublisher/`

其中：

- 配置文件：`config.json`
- 发布账本：`publish-ledger.json`
- 临时素材：`tmp/`
- 运行缓存：`cache/`

如果用户目录里还没有配置文件，程序会自动创建空白模板。
如果检测到旧版项目根目录下已有 `config.json` 或 `publish-ledger.json`，会在首次启动时自动迁移到新位置。
管理页“飞书接入”中还提供：

- 导出配置备份 / 导入配置备份：只迁移配置
- 导出完整数据 / 导入完整数据：迁移配置 + 发布账本

完整数据备份不会包含缓存目录和临时素材。

---

## 配置字段说明

实际生效的 `config.json` 位于系统用户目录中。完整结构可参考 `config.example.json`。

### feishu — 飞书应用凭证（必填）

| 字段 | 必填 | 说明 |
|------|------|------|
| `appId` | ✅ | 飞书应用的 App ID |
| `appSecret` | ✅ | 飞书应用的 App Secret |
| `appToken` | ✅ | 多维表格的 App Token（URL 中 `/base/` 后的部分） |
| `tableId` | ✅ | 数据表的 Table ID（在多维表格设置中查看） |
| `wikiUrl` | — | 仅用于文档说明，程序不读取 |

### yixiaoer — 蚁小二账号（使用蚁小二发布时必填）

| 字段 | 必填 | 说明 |
|------|------|------|
| `apiKey` | ✅ | 蚁小二官方开放 API Key |
| `teamId` | ✅ | 蚁小二团队 ID |
| `clientId` | — | 本机发布客户端 ID；填写后走本机发布，不填走云发布 |
| `username` / `password` | — | 历史遗留字段，当前版本不使用 |

### bitbrowser — 比特浏览器（走比特浏览器渠道时必填）

| 字段 | 必填 | 说明 |
|------|------|------|
| `apiBaseUrl` | — | 比特浏览器本地 API 地址，默认 `http://127.0.0.1:54345` |
| `publishUrl` | — | 小红书发布页地址，默认 `https://creator.xiaohongshu.com/publish/publish` |
| `xiaohongshu` | ✅ | 小红书账号名 → `browserId` 的映射对象（见下方示例） |

`bitbrowser.xiaohongshu` 示例：

```json
"xiaohongshu": {
  "我的账号A": { "browserId": "比特浏览器中的 profile ID" },
  "我的账号B": { "browserId": "另一个 profile ID" }
}
```

账号名需与飞书表格"小红书账号"字段的选项值**完全一致**。

视频笔记走比特浏览器时：
- 会自动进入小红书视频发布页
- 上传 `素材` 字段中的视频文件
- 再用 `视频封面` 字段中的图片设置视频封面

### accountMapping — 蚁小二账号映射（使用蚁小二发布时必填）

飞书账号名 → 蚁小二平台账号 ID 的映射。账号 ID 在蚁小二后台"账号管理"中查看。

```json
"accountMapping": {
  "xiaohongshu": {
    "我的账号A": "蚁小二平台账号ID"
  },
  "douyin": {
    "我的抖音账号": "蚁小二平台账号ID"
  }
}
```

### schedule — 发布时间段（必填）

配置每天自动检查的时间窗口，支持多个时间段：

```json
"schedule": {
  "periods": [
    { "startTime": "06:00", "endTime": "08:00", "intervalMinutes": 30 },
    { "startTime": "19:00", "endTime": "21:00", "intervalMinutes": 60 }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `startTime` / `endTime` | 时间段范围，格式 `HH:MM` |
| `intervalMinutes` | 该时间段内每隔多少分钟检查一次，范围 5–480 |

### defaultMusic — 抖音默认配乐（选填）

```json
"defaultMusic": {
  "id": "蚁小二音乐ID",
  "text": "歌曲名称（用于搜索验证）"
}
```

不填则程序自动回退到热门纯音乐。也可在管理界面"配乐设置"中配置。

### rules — 发布规则（选填）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `douyinMaxTags` | 5 | 抖音最多携带标签数 |
| `titleMaxLength` | — | 保留字段，当前未生效；小红书/抖音标题固定截断为 20 字 |

---

## 飞书多维表格字段

内容表需要以下字段（字段名必须完全一致）：

| 字段名 | 类型 | 说明 |
|--------|------|------|
| `标题` | 文本 | 笔记/视频标题 |
| `正文` | 文本 | 正文内容 |
| `标签` | 多选或文本 | 发布标签，自动去重、过滤 `#` 前缀 |
| `内容类型` | 单选 | `图文` 或 `视频` |
| `素材` | 附件 | 图片或视频文件（按文件名数字顺序排列） |
| `视频封面` | 附件 | 视频封面图（仅内容类型为视频时使用） |
| `小红书账号` | 单选 | 发布到哪个小红书账号（需与 config 账号名一致） |
| `小红书发布渠道` | 单选 | `蚁小二` 或 `比特浏览器` |
| `抖音账号` | 单选 | 发布到哪个抖音账号 |
| `发布时间` | 日期 | 定时发布；空或过去时间表示立即发布 |
| `发布状态` | 单选 | `已发布` 时跳过该条；程序自动写入 |
| `小红书发布状态` | 单选 | 程序自动写入；仅当值为 `待发布` 时才会再次触发发布 |
| `抖音发布状态` | 单选 | 同上 |
| `配乐关键词` | 文本 | 抖音配乐搜索关键词（优先级低于"指定歌曲名"） |
| `指定歌曲名` | 文本 | 抖音精确匹配歌曲名 |
| `备注` | 文本 | 程序自动写入发布记录和错误信息，勿手动编辑 |

---

## 发布规则说明

- **标题截断**：小红书、抖音标题超过 20 字自动截断，截断情况会写入"备注"字段
- **标签数量**：小红书最多取 10 个标签，抖音最多取 5 个；标签按与标题的相关度排序选取
- **重发控制**：飞书的平台发布状态字段是允许重发的唯一开关；只有当"小红书发布状态"或"抖音发布状态"精确等于 `待发布` 时，该平台才会进入实际发布流程
- **失败记录**：`发布失败` 只表示上一次尝试失败，不会被自动发布或“立即发布”强制重试；如需重发，必须手动改回 `待发布`
- **发布时间**：若"发布时间"字段晚于当前时间，该条记录会跳过直到时间到达
- **比特浏览器**：素材先下载到本地临时目录，再由 Playwright 模拟真人上传到小红书发布页
- **素材顺序**：只有文件名“数字开头”的素材会按数字排序（如 `0.png / 1.png / 2.png`）；其余文件保持飞书原顺序，避免 `封面_11.png` 这类名字抢到第一页
- **视频封面**：小红书视频封面走真实页面流程“修改封面 → 上传图片 → 确定”，不是直接替换默认封面字段

---

## 常见问题排查

**启动后提示未完成飞书接入配置**
- 确认已执行 `npm install`
- 打开管理页“飞书接入”，补全 App ID / App Secret / App Token / Table ID
- 如需手动编辑配置，路径见上方《配置与数据目录》

**蚁小二连接失败**
- 检查 `yixiaoer.apiKey` 和 `yixiaoer.teamId` 是否正确
- 在蚁小二后台确认 API Key 未过期、团队 ID 与账号匹配

**比特浏览器发布报错"账号未登录"**
- 手动打开对应 `browserId` 的 profile，在小红书创作者页面完成登录
- 确认 `bitbrowser.apiBaseUrl` 与比特浏览器本地服务端口一致（默认 54345）

**比特浏览器发布报错"未找到上传入口"或"未找到标题输入框"**
- 小红书发布页 UI 可能已更新，需检查并更新 `bitbrowser-xhs.js` 中对应步骤的选择器
- 可先手动在对应 profile 浏览器中打开发布页确认页面是否正常加载

**飞书获取记录失败**
- 检查 `feishu.appId` / `appSecret` 是否正确，飞书应用是否已开通多维表格读写权限
- 确认 `appToken` 和 `tableId` 对应的表格已向该应用授权

**发布任务提交成功但平台显示失败**
- 蚁小二云发布为异步任务，提交成功 ≠ 平台审核通过；请在蚁小二后台查看任务详情
- 比特浏览器发布成功后状态为最终结果

---

## Git 备份与回滚

项目已接入 GitHub：[https://github.com/xiwenran/bjfb](https://github.com/xiwenran/bjfb)

更新代码或蚁小二插件前，建议先打本地备份 tag：

```bash
npm run backup:tag
git push origin --tags
```

执行后会创建类似 `backup-20260323-183000` 的 tag，可用于快速回滚：

```bash
git checkout backup-20260323-183000
```

如果你希望在本地一条命令完成 `add / commit / push`，可以直接使用：

```bash
npm run git:sync -- "feat: 更新说明"
```

这个脚本会：

- 自动 `git add .`
- 使用你传入的提交信息执行 `git commit`
- 推送到当前分支对应的 `origin/<branch>`

如果不传提交信息，会自动生成一个带时间戳的默认说明。

如果 GitHub Actions 生成的 macOS 包和你的本机架构不匹配，也可以先在本地打包，再把本地产物上传到 GitHub Release：

```bash
npm run dist:mac
npm run release:mac-local
```

默认会上传 `dist/NotePublisher macOS.zip`，并自动创建一个带时间戳的 Release。你也可以手动指定文件路径和 tag：

```bash
npm run release:mac-local -- "dist/NotePublisher macOS.zip" "local-mac-manual-20260327"
```

这种方式上传的是发布附件，不会把安装包提交进代码仓库。
