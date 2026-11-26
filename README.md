# Gmail IMAP (Antigravity Global MCP Plugin)

专为 **Google Antigravity** 打造的跨项目全局 Gmail 只读 MCP 插件，通过 Google 官方 **16 位应用专用密码（App Password）** 经标准 IMAP 协议访问邮箱，解决官方 `gmail` CLI 在部分绑定工作区项目下报 `no credentials found` 的问题。

## 功能特点

- **跨项目全局可用**：作为标准 MCP Server 运行，在任意绑定本地文件夹的项目与全局对话中均可稳定调用。
- **内置 5 个实用工具**：
  - `list_recent_emails`：列出最近 N 封邮件（支持指定文件夹、仅看未读）。
  - `search_emails`：支持 Gmail 原生搜索语法（`X-GM-RAW`，如 `from:linkedin`、`has:attachment`、`is:unread`、`newer_than:7d`）。
  - `read_email`：读取邮件完整正文（自动处理纯文本/HTML 及中文编码）与附件清单。
  - `download_attachment`：按 UID 将邮件附件直接下载到本地指定目录。
  - `list_mailboxes`：列出邮箱全部文件夹与标签。
- **自动适配 Windows 本地代理**：自动读取环境变量或 Windows 系统代理（如 Clash Verge / FlClash），无需额外配置即可直连 `imap.gmail.com:993`。
- **凭证安全托管**：通过 Antigravity 插件 `variables` 表单安全填写邮箱与应用专用密码，不将密码写入代码或对话记录。

## 安装与配置

需要本机已安装 **Node.js**（推荐 v18+）。

1. 将本仓库下载或克隆到 Antigravity 插件目录：

   ```powershell
   # Windows 默认插件目录
   C:\Users\<你的用户名>\.gemini\config\plugins\gmail-imap
   ```

2. 进入插件目录并安装依赖：

   ```powershell
   cd C:\Users\<你的用户名>\.gemini\config\plugins\gmail-imap
   npm install
   ```

3. 生成 Google 应用专用密码：
   - 先确保 Google 账号已开启 [两步验证](https://myaccount.google.com/signinoptions/two-step-verification)；
   - 打开 [Google 应用专用密码页面](https://myaccount.google.com/apppasswords)，创建一个新的 16 位应用专用密码。

4. 在 Antigravity 插件管理页打开 **`gmail-imap`**，填入 `GMAIL_USER` 与 `GMAIL_APP_PASSWORD` 并启用插件即可。

## 目录结构

```text
gmail-imap/
├── plugin.json           # Antigravity 插件清单
├── mcp_config.json       # MCP Server 启动配置与安全变量声明
├── index.mjs             # IMAP MCP Server（基于 imapflow & mailparser）
├── rules/gmail-imap.md   # 自动优先调用规则
└── package.json
```

## License

MIT
