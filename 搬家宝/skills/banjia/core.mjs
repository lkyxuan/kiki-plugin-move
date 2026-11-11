// 搬家宝核心：把 Claude Code / Codex 的本机文件转成好读的 Markdown。
// 只有纯函数，不碰文件系统：Kiki 宝（collect.mjs）和网页版都用这一份。

/** 一行一个 JSON，坏行跳过 */
export function jsonl(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

const iso = (t) => {
  if (t == null || t === "") return "";
  const d = typeof t === "number" ? new Date(t < 1e12 ? t * 1000 : t) : new Date(t);
  return isNaN(d) ? "" : d.toISOString();
};

/** 系统塞进来的话（环境信息、指令文件、命令回显），不算用户说的 */
function isNoise(text) {
  const t = text.trim();
  if (!t) return true;
  if (/^<(environment_context|user_instructions|system-reminder|command-|local-command|external_|turn_aborted|user_shell_command|session-context|wake|ide_)/.test(t)) return true;
  if (/^# AGENTS\.md instructions/.test(t)) return true;
  if (/^Caveat: The messages below were generated/.test(t)) return true;
  return false;
}

const textOf = (content, kinds) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && kinds.includes(c.type)).map((c) => c.text || "").join("\n");
};

/**
 * Claude Code 一段对话（~/.claude/projects/<项目>/<id>.jsonl）
 * 返回 { tool, id, title, cwd, branch, start, end, messages: [{ role: "user"|"assistant", text, at, tools: [] }] }
 */
export function parseClaude(text, id = "") {
  const conv = { tool: "Claude Code", id, title: "", cwd: "", branch: "", start: "", end: "", messages: [] };
  let summary = "";
  for (const o of jsonl(text)) {
    if (o.type === "ai-title" && o.aiTitle) conv.title = o.aiTitle;
    if (o.type === "summary" && o.summary && !summary) summary = o.summary;
    if (o.type === "custom-title" && o.customTitle) conv.title = o.customTitle;
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (o.isSidechain) continue;
    if (o.sessionId && !conv.id) conv.id = o.sessionId;
    if (o.cwd && !conv.cwd) conv.cwd = o.cwd;
    if (o.gitBranch && !conv.branch) conv.branch = o.gitBranch;
    const at = iso(o.timestamp);
    if (at) { conv.start ||= at; conv.end = at; }
    const m = o.message || {};
    if (o.type === "user") {
      if (o.isMeta) continue;
      const t = textOf(m.content, ["text"]);
      if (isNoise(t)) continue;
      conv.messages.push({ role: "user", text: t.trim(), at, tools: [] });
    } else {
      const t = textOf(m.content, ["text"]).trim();
      const tools = Array.isArray(m.content) ? m.content.filter((c) => c?.type === "tool_use").map((c) => c.name) : [];
      const last = conv.messages[conv.messages.length - 1];
      // 一轮回答会拆成好几条，合成一条
      if (last && last.role === "assistant") {
        if (t) last.text = last.text ? `${last.text}\n\n${t}` : t;
        last.tools.push(...tools);
      } else if (t || tools.length) {
        conv.messages.push({ role: "assistant", text: t, at, tools });
      }
    }
  }
  conv.title ||= summary || firstLine(conv);
  return conv;
}

/**
 * Codex 一段对话（~/.codex/sessions/年/月/日/rollout-*.jsonl）
 * 新版本用 response_item.message，老版本用 event_msg 的 user_message / agent_message，两种都认。
 */
export function parseCodex(text, id = "", titles = {}) {
  const conv = { tool: "Codex", id, title: "", cwd: "", branch: "", start: "", end: "", messages: [] };
  const rows = jsonl(text);
  const fromItems = [], fromEvents = [];
  let pendingTools = [];
  for (const o of rows) {
    const p = o.payload || {};
    const at = iso(o.timestamp);
    if (o.type === "session_meta") {
      conv.id = p.id || p.session_id || conv.id;
      conv.cwd = p.cwd || conv.cwd;
      conv.branch = p.git?.branch || conv.branch;
      conv.start ||= iso(p.timestamp) || at;
      continue;
    }
    if (at) { conv.start ||= at; conv.end = at; }
    if (o.type === "response_item") {
      if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
        const t = textOf(p.content, ["input_text", "output_text", "text"]).trim();
        if (p.role === "user" && isNoise(t)) continue;
        if (!t) continue;
        fromItems.push({ role: p.role, text: t, at, tools: p.role === "assistant" ? pendingTools.splice(0) : [] });
      } else if (/function_call$|custom_tool_call$|local_shell_call$/.test(p.type || "")) {
        pendingTools.push(p.name || p.type);
      }
    } else if (o.type === "event_msg") {
      if (p.type === "user_message" && p.message && !isNoise(p.message)) fromEvents.push({ role: "user", text: p.message.trim(), at, tools: [] });
      if (p.type === "agent_message" && p.message) fromEvents.push({ role: "assistant", text: p.message.trim(), at, tools: [] });
    }
  }
  const list = fromItems.length ? fromItems : fromEvents;
  for (const m of list) {
    const last = conv.messages[conv.messages.length - 1];
    if (last && last.role === m.role && m.role === "assistant") {
      last.text = `${last.text}\n\n${m.text}`;
      last.tools.push(...m.tools);
    } else conv.messages.push(m);
  }
  conv.title = titles[conv.id] || firstLine(conv);
  return conv;
}

function firstLine(conv) {
  const u = conv.messages.find((m) => m.role === "user");
  return u ? u.text.replace(/\s+/g, " ").slice(0, 40) : "（没有内容）";
}

const localTime = (s) => (s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "");

/** 一段对话 → Markdown */
export function toMarkdown(conv) {
  const head = [
    `# ${conv.title}`,
    "",
    `- 来源: ${conv.tool}`,
    conv.cwd ? `- 项目: ${conv.cwd}` : null,
    conv.branch ? `- 分支: ${conv.branch}` : null,
    conv.start ? `- 开始: ${localTime(conv.start)}` : null,
    conv.end ? `- 最后: ${localTime(conv.end)}` : null,
    conv.id ? `- 对话 id: ${conv.id}` : null,
    "",
  ].filter((x) => x != null);
  const body = conv.messages.map((m) => {
    const who = m.role === "user" ? "## 我" : `## ${conv.tool}`;
    const tools = m.tools?.length ? `\n\n> 用了工具：${summarizeTools(m.tools)}` : "";
    return `${who}${m.at ? ` · ${localTime(m.at)}` : ""}\n\n${m.text}${tools}`;
  });
  return `${head.join("\n")}\n${body.join("\n\n")}\n`;
}

function summarizeTools(tools) {
  const n = {};
  for (const t of tools) n[t] = (n[t] || 0) + 1;
  return Object.entries(n).map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join("、");
}

/** 文件名里不能有的字符换掉，太长截断 */
export function safeName(s, max = 60) {
  return String(s || "未命名").replace(/[\/\\:*?"<>|\n\r\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "未命名";
}

/** 项目路径 → 短名字（最后一段） */
export function projectName(cwd) {
  if (!cwd) return "没有项目";
  const parts = cwd.replace(/\/+$/, "").split("/");
  // Codex 普通聊天：~/Documents/Codex/<日期>/<slug>
  if (parts.includes("Codex") && /^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 2] || "")) return "普通聊天";
  return parts[parts.length - 1] || "没有项目";
}

// ---------- 交接素材：只挑用户自己说的话，省 token ----------

const CORRECTION = /不对|不是这样|错了|重写|重做|重新|别再|不要|别这样|不用|太长|太短|简单点|说人话|我说的是|我的意思是|以后都|以后别|记住|每次都|总是|又忘|还是不|没听懂|不行|改回|应该是|而不是|instead|don't|do not|stop |wrong|redo|rewrite|not what i|always |never /i;

export const isCorrection = (t) => CORRECTION.test(t);

/**
 * 从一段对话挑交接素材：用户说的每句话（截短），纠正的话带上前一条 AI 回答的开头。
 * 返回 { lines: [{at, text, correction, before}] }
 */
export function handoffLines(conv, maxLen = 400) {
  const out = [];
  conv.messages.forEach((m, i) => {
    if (m.role !== "user") return;
    const text = m.text.length > maxLen ? `${m.text.slice(0, maxLen)}…` : m.text;
    const correction = i > 0 && isCorrection(m.text);
    const prev = correction ? conv.messages[i - 1] : null;
    out.push({ at: m.at, text, correction, before: prev ? prev.text.replace(/\s+/g, " ").slice(0, 200) : "" });
  });
  return out;
}

/** 粗估 token：中文约 1 字 1 token，英文约 4 字母 1 token */
export function estimateTokens(text) {
  const s = String(text || "");
  const cjk = (s.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  return Math.round(cjk + (s.length - cjk) / 4);
}

// ---------- 密钥打码 ----------

const SECRET_KEY = /(key|token|secret|password|passwd|auth|credential|cookie|bearer)/i;

/** 打码一个值：留头 4 个字符 */
const mask = (v) => {
  const s = String(v ?? "");
  return s.length <= 6 ? "***" : `${s.slice(0, 4)}***（已打码）`;
};

/** 把对象里像密钥的值打码（env、headers 全部打码） */
export function maskObject(obj, parentKey = "") {
  if (Array.isArray(obj)) return obj.map((x, i) => (typeof x === "string" && i > 0 && /^--?[\w-]*(key|token|secret|password|auth)[\w-]*$/i.test(String(obj[i - 1])) ? "***" : maskObject(x, parentKey)));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if ((/^(env|headers)$/i.test(parentKey) || SECRET_KEY.test(k)) && typeof v !== "object") out[k] = mask(v);
      else out[k] = maskObject(v, k);
    }
    return out;
  }
  if (typeof obj === "string" && /^(sk-|ghp_|gho_|xox[bp]-|eyJ)[A-Za-z0-9_\-.]{10,}/.test(obj)) return mask(obj);
  if (typeof obj === "string") return maskInline(obj);
  return obj;
}

/** TOML / .env / 普通文本里打码：键名像密钥的行、env 里的所有值、长得像令牌的串 */
export function maskText(text) {
  let inEnv = false;
  return String(text || "")
    .split("\n")
    .map((line) => {
      const h = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (h) { inEnv = /(^|\.)(env|headers|http_headers)$/.test(h[1]); return line; }
      // env = { A = "x", B = "y" } 这种一行写完的
      if (/^\s*(env|headers|http_headers)\s*=\s*\{/.test(line)) return line.replace(/=\s*("[^"]*"|'[^']*'|[^,}\s]+)(?=\s*[,}])/g, '= "***（已打码）"');
      if (inEnv && /^\s*[\w."-]+\s*=/.test(line)) return line.replace(/=.*$/, '= "***（已打码）"');
      const kv = line.match(/^(\s*[\w.\-"]*?(key|token|secret|password|auth|credential|cookie|bearer)[\w.\-"]*\s*[=:]\s*)(.+)$/i);
      if (kv) return `${kv[1]}"***（已打码）"`;
      return line.replace(/(sk-|ghp_|gho_|xox[bp]-)[A-Za-z0-9_\-]{10,}/g, "$1***（已打码）");
    })
    .join("\n");
}

// ---------- 连接器清单 ----------

/** 一行连接方式（命令参数、网址）里打码：令牌样子的串、?token= 这类参数、--api-key 后面的值 */
export function maskInline(s) {
  return String(s || "")
    .replace(/(sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abposr]-|AKIA|AIza)[A-Za-z0-9_\-]{8,}/g, "$1***")
    .replace(/([?&][\w-]*(key|token|secret|password|auth|sig)[\w-]*=)[^&\s"]+/gi, "$1***")
    .replace(/(--?[\w-]*(key|token|secret|password|auth)[\w-]*[= ])("[^"]*"|\S+)/gi, "$1***")
    .replace(/(\/\/[^/:@\s]+:)[^@\s]+@/g, "$1***@")
    .replace(/(Bearer\s+)\S+/gi, "$1***");
}

/** ~/.claude.json 和 .mcp.json 里的 mcpServers → [{name, scope, how}] */
export function claudeMcp(claudeJson, scopeName = "全局") {
  const out = [];
  const add = (servers, scope) => {
    for (const [name, s] of Object.entries(servers || {})) {
      out.push({ name, scope, how: maskInline(s.url ? `${s.type || "http"} ${s.url}` : [s.command, ...(s.args || [])].filter(Boolean).join(" ")), env: Object.keys(s.env || {}) });
    }
  };
  add(claudeJson?.mcpServers, scopeName);
  for (const [path, p] of Object.entries(claudeJson?.projects || {})) add(p?.mcpServers, `项目 ${path}`);
  return out;
}

/** Codex config.toml 里的 [mcp_servers.名字] → [{name, scope, how}]（只认简单写法） */
export function codexMcp(toml) {
  const out = [];
  let cur = null;
  for (const line of String(toml || "").split("\n")) {
    const h = line.match(/^\s*\[mcp_servers\.([^\].]+)\]\s*$/);
    if (h) { cur = { name: h[1].replace(/"/g, ""), scope: "全局", how: "", env: [] }; out.push(cur); continue; }
    if (/^\s*\[/.test(line)) {
      const sub = line.match(/^\s*\[mcp_servers\.([^\].]+)\.env\]/);
      cur = sub ? out.find((x) => x.name === sub[1].replace(/"/g, "")) || null : null;
      if (cur && sub) cur._env = true;
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^\s*([\w-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    if (cur._env) { cur.env.push(kv[1]); continue; }
    if (kv[1] === "command") cur.how = kv[2].replace(/^"|"$/g, "") + (cur.how ? ` ${cur.how}` : "");
    if (kv[1] === "args") cur.how += ` ${kv[2].replace(/[\[\]"]/g, "").replace(/,\s*/g, " ")}`;
    if (kv[1] === "url") cur.how = kv[2].replace(/^"|"$/g, "");
    if (kv[1] === "env") cur.env.push(...[...kv[2].matchAll(/([\w-]+)\s*=/g)].map((m) => m[1]));
  }
  return out.map(({ _env, ...x }) => ({ ...x, how: maskInline(x.how.trim()) }));
}

export function mcpMarkdown(list) {
  if (!list.length) return "（没找到）\n";
  return [
    "| 名字 | 来源 | 范围 | 怎么连 | 要填的环境变量 | 用途（自己补） |",
    "| --- | --- | --- | --- | --- | --- |",
    ...list.map((x) => `| ${x.name} | ${x.tool} | ${x.scope} | \`${(x.how || "").replace(/\|/g, "\\|")}\` | ${x.env.join("、") || "—"} | |`),
  ].join("\n") + "\n";
}
