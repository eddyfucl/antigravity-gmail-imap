import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function detectSystemProxy() {
  const envProxy =
    process.env.GMAIL_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (envProxy && envProxy.trim()) return envProxy.trim();

  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "reg",
        [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        ],
        { encoding: "utf8", windowsHide: true, timeout: 2000 }
      );
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
      if (enabled) {
        const m = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
        if (m && m[1]) {
          let srv = m[1].trim();
          // Handle "http=127.0.0.1:7897;https=127.0.0.1:7897" format
          if (srv.includes("=")) {
            const parts = Object.fromEntries(
              srv.split(";").map((kv) => kv.split("=").map((s) => s.trim()))
            );
            srv = parts.https || parts.http || parts.socks || "";
          }
          if (srv && !/^[a-z0-9]+:\/\//i.test(srv)) {
            srv = `http://${srv}`;
          }
          if (srv) return srv;
        }
      }
    } catch {
      // Ignore registry read failures
    }
  }
  return undefined;
}

function getCredentials() {
  const user = (process.env.GMAIL_USER || "").trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass || user.startsWith("${") || pass.startsWith("${")) {
    throw new Error(
      "尚未配置 Gmail 账号或应用专用密码。请在 Antigravity 插件管理页的 gmail-imap 中填写 GMAIL_USER 和 GMAIL_APP_PASSWORD 并启用插件。"
    );
  }
  return { user, pass };
}

async function withImap(fn) {
  const { user, pass } = getCredentials();
  const proxy = detectSystemProxy();
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    ...(proxy ? { proxy } : {}),
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

function formatDateCN(d) {
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(d));
  } catch {
    return String(d);
  }
}

function formatAddressList(list) {
  if (!Array.isArray(list) || list.length === 0) return "";
  return list
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address || ""))
    .filter(Boolean)
    .join(", ");
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchSummaries(client, uids, limit) {
  const sorted = [...uids].sort((a, b) => b - a).slice(0, limit);
  if (sorted.length === 0) return [];
  const items = [];
  for await (const msg of client.fetch(sorted, {
    uid: true,
    flags: true,
    envelope: true,
    internalDate: true,
  }, { uid: true })) {
    const env = msg.envelope || {};
    items.push({
      uid: msg.uid,
      date: formatDateCN(env.date || msg.internalDate),
      from: formatAddressList(env.from),
      subject: env.subject || "(无主题)",
      unread: !msg.flags?.has("\\Seen"),
    });
  }
  items.sort((a, b) => b.uid - a.uid);
  return items;
}

const server = new Server(
  { name: "gmail-imap", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_recent_emails",
      title: "列出最近邮件",
      description: "获取 Gmail 指定文件夹（默认 INBOX 收件箱）中最近的 N 封邮件摘要。",
      inputSchema: {
        type: "object",
        properties: {
          max: { type: "number", description: "返回条数，默认 10，最大 50" },
          mailbox: { type: "string", description: "邮箱文件夹名，默认 INBOX" },
          unreadOnly: { type: "boolean", description: "是否仅列出未读邮件，默认 false" },
        },
      },
    },
    {
      name: "search_emails",
      title: "搜索 Gmail 邮件",
      description:
        "使用 Gmail 原生搜索语法（如 UCL、from:linkedin、has:attachment、is:unread、newer_than:7d）搜索邮件。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail 搜索关键词或语法" },
          max: { type: "number", description: "返回条数，默认 10，最大 50" },
          mailbox: {
            type: "string",
            description: "搜索范围，默认 INBOX（搜全部邮件可填 [Gmail]/All Mail）",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "read_email",
      title: "读取邮件正文与附件列表",
      description: "按 UID 读取单封邮件的完整发件人、主题、时间、正文内容和附件清单。",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "number", description: "邮件 UID（由 list_recent_emails 或 search_emails 返回）" },
          mailbox: { type: "string", description: "所在文件夹，默认 INBOX" },
          maxChars: { type: "number", description: "正文最大字符数，默认 8000" },
        },
        required: ["uid"],
      },
    },
    {
      name: "download_attachment",
      title: "下载邮件附件到本地",
      description: "将指定 UID 邮件中的附件保存到本地目录。",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "number", description: "邮件 UID" },
          saveDir: { type: "string", description: "保存目录的 Windows 绝对路径，如 D:\\桌面\\求职" },
          filename: { type: "string", description: "可选：仅下载匹配的附件文件名；留空则下载该邮件全部附件" },
          mailbox: { type: "string", description: "所在文件夹，默认 INBOX" },
        },
        required: ["uid", "saveDir"],
      },
    },
    {
      name: "list_mailboxes",
      title: "列出邮箱文件夹/标签",
      description: "列出 Gmail 账号下的全部 IMAP 文件夹与标签名称。",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === "list_mailboxes") {
      const boxes = await withImap(async (client) => {
        const list = await client.list();
        return list.map((b) => ({ path: b.path, specialUse: b.specialUse || "" }));
      });
      return {
        content: [
          {
            type: "text",
            text: boxes
              .map((b) => `- ${b.path}${b.specialUse ? ` (${b.specialUse})` : ""}`)
              .join("\n"),
          },
        ],
      };
    }

    if (name === "list_recent_emails") {
      const limit = Math.min(Math.max(Number(args.max) || 10, 1), 50);
      const mailbox = String(args.mailbox || "INBOX");
      const unreadOnly = Boolean(args.unreadOnly);

      const items = await withImap(async (client) => {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const criteria = unreadOnly ? { seen: false } : { all: true };
          const uids = await client.search(criteria, { uid: true });
          return await fetchSummaries(client, uids, limit);
        } finally {
          lock.release();
        }
      });

      if (items.length === 0) {
        return { content: [{ type: "text", text: `文件夹 ${mailbox} 中没有符合条件的邮件。` }] };
      }
      const lines = items.map(
        (m, i) =>
          `${i + 1}. [UID:${m.uid}]${m.unread ? " [未读]" : ""} ${m.subject}\n   发件人: ${m.from} | 时间: ${m.date}`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    if (name === "search_emails") {
      const query = String(args.query || "").trim();
      if (!query) {
        return { isError: true, content: [{ type: "text", text: "请提供搜索关键词 query。" }] };
      }
      const limit = Math.min(Math.max(Number(args.max) || 10, 1), 50);
      const mailbox = String(args.mailbox || "INBOX");

      const items = await withImap(async (client) => {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const uids = await client.search({ gmraw: query }, { uid: true });
          return await fetchSummaries(client, uids, limit);
        } finally {
          lock.release();
        }
      });

      if (items.length === 0) {
        return { content: [{ type: "text", text: `在 ${mailbox} 中未搜到匹配 "${query}" 的邮件。` }] };
      }
      const lines = items.map(
        (m, i) =>
          `${i + 1}. [UID:${m.uid}]${m.unread ? " [未读]" : ""} ${m.subject}\n   发件人: ${m.from} | 时间: ${m.date}`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    if (name === "read_email") {
      const uid = Number(args.uid);
      if (!uid) {
        return { isError: true, content: [{ type: "text", text: "请提供有效的数字 uid。" }] };
      }
      const mailbox = String(args.mailbox || "INBOX");
      const maxChars = Math.min(Math.max(Number(args.maxChars) || 8000, 500), 40000);

      const parsed = await withImap(async (client) => {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg || !msg.source) return null;
          return await simpleParser(msg.source);
        } finally {
          lock.release();
        }
      });

      if (!parsed) {
        return { isError: true, content: [{ type: "text", text: `未找到 UID=${uid} 的邮件。` }] };
      }

      const bodyText = (parsed.text && parsed.text.trim()) || stripHtml(parsed.html) || "(无正文)";
      const clipped =
        bodyText.length > maxChars
          ? bodyText.slice(0, maxChars) + `\n\n...(正文已截断，总长 ${bodyText.length} 字符)`
          : bodyText;
      const attachments = (parsed.attachments || []).map(
        (a) => `${a.filename || "未命名附件"} (${Math.round((a.size || 0) / 1024)} KB)`
      );

      const out = [
        `主题: ${parsed.subject || "(无主题)"}`,
        `发件人: ${parsed.from?.text || ""}`,
        `收件人: ${parsed.to?.text || ""}`,
        parsed.cc?.text ? `抄送: ${parsed.cc.text}` : "",
        `时间: ${formatDateCN(parsed.date)}`,
        attachments.length > 0 ? `附件 (${attachments.length}): ${attachments.join("; ")}` : "附件: 无",
        "--- 正文 ---",
        clipped,
      ]
        .filter(Boolean)
        .join("\n");

      return { content: [{ type: "text", text: out }] };
    }

    if (name === "download_attachment") {
      const uid = Number(args.uid);
      const saveDir = String(args.saveDir || "").trim();
      const targetName = args.filename ? String(args.filename).trim() : "";
      const mailbox = String(args.mailbox || "INBOX");
      if (!uid || !saveDir) {
        return { isError: true, content: [{ type: "text", text: "请提供 uid 和 saveDir。" }] };
      }

      const saved = await withImap(async (client) => {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg || !msg.source) return null;
          const parsed = await simpleParser(msg.source);
          const atts = parsed.attachments || [];
          fs.mkdirSync(saveDir, { recursive: true });
          const written = [];
          for (const att of atts) {
            const fname = (att.filename || `attachment_${written.length + 1}.bin`).replace(/[<>:"/\\|?*]/g, "_");
            if (targetName && fname !== targetName && att.filename !== targetName) continue;
            const dest = path.join(saveDir, fname);
            fs.writeFileSync(dest, att.content);
            written.push(dest);
          }
          return written;
        } finally {
          lock.release();
        }
      });

      if (saved === null) {
        return { isError: true, content: [{ type: "text", text: `未找到 UID=${uid} 的邮件。` }] };
      }
      if (saved.length === 0) {
        return { content: [{ type: "text", text: "该邮件没有匹配的附件可下载。" }] };
      }
      return {
        content: [{ type: "text", text: `已下载 ${saved.length} 个附件：\n${saved.map((p) => `- ${p}`).join("\n")}` }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Gmail IMAP 调用失败：${err?.message || String(err)}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
