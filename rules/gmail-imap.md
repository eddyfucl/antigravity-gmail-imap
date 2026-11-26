---
trigger: always_on
---

# Gmail IMAP 全局邮件读取规则

- 当需要读取、搜索用户的 Gmail 邮件或下载邮件附件时（尤其是在绑定了工作区文件夹的项目中，或官方 `gmail` CLI 报 `no credentials found` 时），优先使用 `gmail-imap_mail` MCP 服务提供的工具：`list_recent_emails`、`search_emails`、`read_email`、`download_attachment`、`list_mailboxes`。
- 下载附件到本地后，按文件交付规范调用 `win-explorer_explorer` 的 `show_files` 展示卡片。
