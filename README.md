# 蚁小二发布工具

飞书多维表格驱动的自动发布项目：

- 小红书支持两种渠道：
  - 蚁小二
  - 比特浏览器
- 抖音固定走蚁小二

## 本地启动

1. 复制 `config.example.json` 为 `config.json`
2. 填写飞书、蚁小二、BitBrowser 相关配置
3. 安装依赖：

```bash
npm install
```

4. 启动服务：

```bash
npm start
```

启动后访问：

- [http://localhost:3210](http://localhost:3210)

## 配置说明

敏感配置保存在本地 `config.json`，不会进入 Git。

示例结构见：

- [config.example.json](/Users/xili/Downloads/workspace/config.example.json)

重点字段：

- `feishu`
  - 飞书应用凭证
  - 多维表格 `appToken` / `tableId`
- `yixiaoer`
  - `apiKey`
  - `teamId`
  - `clientId`（本机发布时使用）
- `bitbrowser.xiaohongshu`
  - 小红书账号名到 `browserId` 的映射
- `accountMapping`
  - 飞书账号名到蚁小二平台账号 ID 的映射

## 飞书字段

内容表至少需要这些字段：

- `标题`
- `正文`
- `标签`
- `内容类型`
- `素材`
- `视频封面`
- `小红书账号`
- `抖音账号`
- `发布时间`
- `小红书发布状态`
- `抖音发布状态`
- `备注`

小红书双渠道字段：

- `小红书发布渠道`
  - 单选
  - `蚁小二`
  - `比特浏览器`

## 当前规则

- 小红书、抖音标题发布前会自动按 20 字截断
- 小红书标签最多取 10 个
- 抖音标签最多取 5 个
- 飞书平台状态字段是是否允许重发的唯一开关
- 小红书走比特浏览器时，先下载飞书素材到本地，再上传到小红书发布页

## Git 备份与回滚

项目已接入 GitHub：

- [https://github.com/xiwenran/bjfb](https://github.com/xiwenran/bjfb)

更新官方蚁小二插件前，建议先打一个本地备份 tag：

```bash
npm run backup:tag
git push origin --tags
```

这样如果后面验证新版插件不理想，可以快速回到当前版本。

## 备份 tag 规则

执行 `npm run backup:tag` 后，会创建类似这样的 tag：

- `backup-20260323-183000`

这个 tag 只给当前项目做版本锚点，不会自动升级或自动回滚。
