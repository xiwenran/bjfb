---
name: successful-publish-fix
description: 蚁小二发布图片失败问题的成功解决方案
type: feedback
---

发布内容时避免使用占位符图片链接，必须使用真实的在线图片。

**Why:** via.placeholder.com 等占位符链接无法被蚁小二云存储正确处理，导致图片上传失败，从而整个发布任务失败。即使API返回"成功"，实际在蚁小二后台显示为失败状态。

**How to apply:**
1. 使用真实的在线图片服务（如 Unsplash: `https://source.unsplash.com/1080x1350/?keyword`）
2. 或从飞书下载真实附件后上传到蚁小二云存储
3. 确保在同一进程中保持蚁小二登录会话状态
4. 使用正确的 platformAccountId 和 teamId 参数
5. 添加适当的等待时间避免请求过快导致失败