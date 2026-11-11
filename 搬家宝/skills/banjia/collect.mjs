#!/usr/bin/env node
// 收本机家当：node collect.mjs --out <迁移文件夹> [--data <本宝 data 目录>] [--months 3] [--zip]
// 读 ~/.claude、~/.claude.json、~/.codex（CLAUDE_CONFIG_DIR、CODEX_HOME 可改），整理成迁移文件夹。
// 不联网、不用 AI、不带登录凭证。再跑一次只更新变了的文件。最后打印一段 JSON 摘要。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import * as zlib from "node:zlib";
import {
  parseClaude, parseCodex, toMarkdown, safeName, projectName, handoffLines, estimateTokens,
  maskObject, maskText, claudeMcp, codexMcp, mcpMarkdown, jsonl,
} from "./core.mjs";
import { handoffGuide, moveInGuide, CLOUD } from "./prompts.mjs";

// ---------- 参数 ----------
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const HOME = homedir();
const OUT = opt("out", join(HOME, "kiki-data", "搬家"));
const DATA = opt("data", "");
const MONTHS = Number(opt("months", "3")) || 3;
const ZIP = args.includes("--zip");
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
const CLAUDE_JSON = join(HOME, ".claude.json");
const CODEX = process.env.CODEX_HOME || join(HOME, ".codex");
const SINCE = Date.now() - MONTHS * 30 * 864e5;

// ---------- 文件小工具 ----------
const SKIP_FILE = /^(auth\.json|\.credentials\.json|credentials\.json|.*\.lock|\.env.*|.*\.pem|.*\.key|\.DS_Store)$/i;
const MAX_FILE = 200 * 1024 * 1024;
const stat = (p) => { try { return statSync(p); } catch { return null; } };
const isDir = (p) => stat(p)?.isDirectory() || false;
const isFile = (p) => stat(p)?.isFile() || false;
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const ls = (p) => { try { return readdirSync(p); } catch { return []; } };

/** 递归列文件（跟随软链接），跳过点开头的文件夹、node_modules */
function walk(dir, filter = () => true, out = []) {
  for (const name of ls(dir)) {
    const p = join(dir, name);
    const s = stat(p);
    if (!s) continue;
    if (s.isDirectory()) { if (!name.startsWith(".") && name !== "node_modules") walk(p, filter, out); }
    else if (s.isFile() && filter(p, name)) out.push(p);
  }
  return out;
}

const written = { files: 0, skipped: 0 };
/** 只在内容变了时写 */
function put(path, text) {
  const full = join(OUT, path);
  if (read(full) === text) { written.skipped++; return; }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  written.files++;
}
/** 只在大小或修改时间变了时复制；密钥文件不复制 */
function copy(src, dstRel) {
  const s = stat(src);
  if (!s || !s.isFile() || SKIP_FILE.test(basename(src)) || s.size > MAX_FILE) return false;
  const dst = join(OUT, dstRel);
  const d = stat(dst);
  if (d && d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 1000) { written.skipped++; return true; }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  try { utimesSync(dst, s.atime, s.mtime); } catch {}
  written.files++;
  return true;
}
/** 复制整个文件夹，返回复制了几个文件 */
function copyTree(src, dstRel, filter) {
  let n = 0;
  for (const f of walk(src, filter)) if (copy(f, join(dstRel, relative(src, f)))) n++;
  return n;
}
/** 列出一个 skills 文件夹里有哪些技能（顶层子文件夹或 .md） */
const skillNames = (dir) => ls(dir).filter((n) => !n.startsWith(".") && (isDir(join(dir, n)) || n.endsWith(".md")));

// ---------- 统计 ----------
const counts = {
  记忆: { Claude: 0, Codex: 0 },
  聊天: { Claude: 0, Codex: 0 },
  账号数据: { Claude: 0, Codex: 0 },
  Skill: { Claude: 0, Codex: 0 },
  指令: { Claude: 0, Codex: 0 },
  连接器: { Claude: 0, Codex: 0 },
  附件: { Claude: 0, Codex: 0 },
};
const notes = [];
const index = []; // 聊天目录
const handoff = new Map(); // "工具 · 项目" → [{conv, lines}]
const projectDirs = new Map(); // cwd → 工具集合
const usedNames = new Map(); // 项目短名 → cwd（防重名）

function projectFolder(cwd) {
  if (projectName(cwd) === "普通聊天") cwd = "普通聊天";
  const base = safeName(projectName(cwd), 40);
  const prev = usedNames.get(base);
  if (!prev || prev === cwd) { usedNames.set(base, cwd); return base; }
  let i = 2;
  while (usedNames.has(`${base}-${i}`) && usedNames.get(`${base}-${i}`) !== cwd) i++;
  usedNames.set(`${base}-${i}`, cwd);
  return `${base}-${i}`;
}

function addConversation(conv, rawRel) {
  if (!conv.messages.length) return;
  const proj = projectFolder(conv.cwd);
  const day = (conv.start || "").slice(0, 10) || "没有日期";
  const tool = conv.tool === "Codex" ? "Codex" : "Claude Code";
  const name = `${day} ${safeName(conv.title)}${conv.id ? ` · ${conv.id.slice(0, 8)}` : ""}.md`;
  const rel = join("聊天", tool, proj, name);
  put(rel, toMarkdown(conv));
  index.push({ tool, proj, day, title: conv.title, rel, n: conv.messages.length, raw: rawRel });
  if (conv.cwd && conv.cwd !== HOME && !/\/Documents\/Codex\/\d{4}-/.test(conv.cwd)) {
    if (!projectDirs.has(conv.cwd)) projectDirs.set(conv.cwd, new Set());
    projectDirs.get(conv.cwd).add(tool);
  }
  const t = Date.parse(conv.end || conv.start || "");
  if (!isNaN(t) && t >= SINCE) {
    const key = `${tool} · ${proj}`;
    if (!handoff.has(key)) handoff.set(key, []);
    handoff.get(key).push({ conv, rel, lines: handoffLines(conv) });
  }
}

/** .jsonl.zst 解压（Node 22.15+ 自带；不行就用系统 zstd） */
function readMaybeZst(p) {
  if (!p.endsWith(".zst")) return read(p);
  try { if (zlib.zstdDecompressSync) return zlib.zstdDecompressSync(readFileSync(p)).toString("utf8"); } catch {}
  try { return execFileSync("zstd", ["-dc", p], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8"); } catch {}
  return null;
}

// ======================= Claude =======================
const haveClaude = isDir(CLAUDE) || isFile(CLAUDE_JSON);
const mcpList = [];
const pluginList = [];
if (haveClaude) {
  // 聊天
  const projDir = join(CLAUDE, "projects");
  for (const p of ls(projDir)) {
    const dir = join(projDir, p);
    if (!isDir(dir)) continue;
    for (const f of ls(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const src = join(dir, f);
      const raw = join("原始文件", "Claude", "projects", p, f);
      copy(src, raw);
      const conv = parseClaude(read(src), f.replace(/\.jsonl$/, ""));
      if (conv.messages.length) counts.聊天.Claude++;
      addConversation(conv, raw);
    }
    // 自动记忆：projects/<项目>/memory/
    const mem = join(dir, "memory");
    if (isDir(mem)) counts.记忆.Claude += copyTree(mem, join("记忆", "Claude", p));
  }
  if (copy(join(CLAUDE, "history.jsonl"), join("原始文件", "Claude", "history.jsonl"))) {}

  // 个人指令
  for (const f of ["CLAUDE.md", "CLAUDE.local.md"]) {
    if (copy(join(CLAUDE, f), join("指令", "Claude", `个人-${f}`))) counts.指令.Claude++;
  }
  if (copyTree(join(CLAUDE, "rules"), join("指令", "Claude", "rules"))) counts.指令.Claude++;
  if (isDir(join(CLAUDE, "output-styles"))) counts.指令.Claude += copyTree(join(CLAUDE, "output-styles"), join("指令", "Claude", "output-styles"));

  // Skills、子 agent、命令
  for (const kind of ["skills", "agents", "commands"]) {
    const dir = join(CLAUDE, kind);
    if (!isDir(dir)) continue;
    copyTree(dir, join("Skills", "Claude", kind));
    counts.Skill.Claude += skillNames(dir).length;
  }

  // 连接器和插件
  const cj = (() => { try { return JSON.parse(read(CLAUDE_JSON) || "{}"); } catch { return {}; } })();
  mcpList.push(...claudeMcp(cj).map((x) => ({ ...x, tool: "Claude Code" })));
  const settings = (() => { try { return JSON.parse(read(join(CLAUDE, "settings.json")) || "{}"); } catch { return null; } })();
  if (settings) put(join("连接器和插件", "Claude-settings（已打码）.json"), JSON.stringify(maskObject(settings), null, 2) + "\n");
  if (cj.mcpServers || cj.projects) {
    const keep = { mcpServers: cj.mcpServers || {}, projects: Object.fromEntries(Object.entries(cj.projects || {}).filter(([, v]) => v?.mcpServers && Object.keys(v.mcpServers).length).map(([k, v]) => [k, { mcpServers: v.mcpServers }])) };
    put(join("连接器和插件", "Claude-mcp（已打码）.json"), JSON.stringify(maskObject(keep), null, 2) + "\n");
  }
  const installed = (() => { try { return JSON.parse(read(join(CLAUDE, "plugins", "installed_plugins.json")) || "{}"); } catch { return {}; } })();
  for (const name of Object.keys(installed.plugins || installed || {})) if (name !== "version") pluginList.push({ tool: "Claude Code", name });
  counts.连接器.Claude = mcpList.length + pluginList.filter((x) => x.tool === "Claude Code").length;
}

// ======================= Codex =======================
const haveCodex = isDir(CODEX);
if (haveCodex) {
  const titles = {};
  for (const o of jsonl(read(join(CODEX, "session_index.jsonl")))) if (o.id && o.thread_name) titles[o.id] = o.thread_name;
  copy(join(CODEX, "session_index.jsonl"), join("原始文件", "Codex", "session_index.jsonl"));
  copy(join(CODEX, "history.jsonl"), join("原始文件", "Codex", "history.jsonl"));

  const files = [
    ...walk(join(CODEX, "sessions"), (p) => /\.jsonl(\.zst)?$/.test(p)),
    ...walk(join(CODEX, "archived_sessions"), (p) => /\.jsonl(\.zst)?$/.test(p)),
  ];
  let unread = 0;
  for (const src of files) {
    const raw = join("原始文件", "Codex", relative(CODEX, src));
    copy(src, raw);
    const text = readMaybeZst(src);
    if (text == null) { unread++; continue; }
    const conv = parseCodex(text, basename(src).replace(/\.jsonl(\.zst)?$/, ""), titles);
    if (conv.messages.length) counts.聊天.Codex++;
    addConversation(conv, raw);
  }
  if (unread) notes.push(`有 ${unread} 个归档的 Codex 对话是压缩的（.zst），这台电脑解不开，只放了原始文件。装个 zstd（brew install zstd）再收一次就能转成 Markdown。`);

  // 记忆
  if (isDir(join(CODEX, "memories"))) counts.记忆.Codex += copyTree(join(CODEX, "memories"), join("记忆", "Codex"));
  for (const f of ls(CODEX)) if (/^memories.*\.sqlite$/.test(f)) copy(join(CODEX, f), join("原始文件", "Codex", f));

  // 指令
  for (const f of ["AGENTS.md", "AGENTS.override.md", "instructions.md"]) {
    if (copy(join(CODEX, f), join("指令", "Codex", `个人-${f}`))) counts.指令.Codex++;
  }
  if (isDir(join(CODEX, "rules"))) counts.指令.Codex += copyTree(join(CODEX, "rules"), join("指令", "Codex", "rules"));

  // Skills（.system 是自带的，跳过）、提示词
  for (const kind of ["skills", "prompts"]) {
    const dir = join(CODEX, kind);
    if (!isDir(dir)) continue;
    copyTree(dir, join("Skills", "Codex", kind));
    counts.Skill.Codex += skillNames(dir).length;
  }

  // 连接器和插件
  const toml = read(join(CODEX, "config.toml"));
  if (toml) {
    put(join("连接器和插件", "Codex-config（已打码）.toml"), maskText(toml));
    const list = codexMcp(toml).map((x) => ({ ...x, tool: "Codex" }));
    mcpList.push(...list);
    counts.连接器.Codex += list.length;
  }
  for (const name of ls(join(CODEX, "plugins"))) if (!name.startsWith(".") && name !== "cache") { pluginList.push({ tool: "Codex", name }); counts.连接器.Codex++; }

  // 附件
  if (isDir(join(CODEX, "attachments"))) counts.附件.Codex += copyTree(join(CODEX, "attachments"), join("附件", "Codex"));
}

// ======================= 项目里的指令和 Skills =======================
const PROJECT_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/CLAUDE.md", ".mcp.json"];
const PROJECT_DIRS = [".claude/skills", ".claude/commands", ".claude/agents", ".codex/skills", ".agents/skills"];
for (const [cwd, tools] of projectDirs) {
  if (!isDir(cwd)) continue;
  const name = projectFolder(cwd);
  let found = 0;
  for (const f of PROJECT_FILES) {
    const src = join(cwd, f);
    if (!isFile(src)) continue;
    if (f === ".mcp.json") {
      try {
        const j = JSON.parse(read(src));
        put(join("连接器和插件", "项目", `${name}-mcp（已打码）.json`), JSON.stringify(maskObject(j), null, 2) + "\n");
        mcpList.push(...claudeMcp(j, `项目 ${cwd}`).map((x) => ({ ...x, tool: "Claude Code" })));
      } catch {}
      continue;
    }
    if (copy(src, join("指令", "项目", name, f.replace(/\//g, "-")))) found++;
  }
  for (const d of PROJECT_DIRS) {
    const src = join(cwd, d);
    if (isDir(src)) copyTree(src, join("Skills", "项目", name, d.replace(/\//g, "-")));
  }
  if (found) {
    if (tools.has("Codex") && !tools.has("Claude Code")) counts.指令.Codex += found;
    else counts.指令.Claude += found;
  }
  put(join("指令", "项目", name, "项目路径.txt"), `${cwd}\n`);
}

// ======================= 连接器清单 =======================
put(join("连接器和插件", "清单.md"), `# 连接器和插件清单

连接器的授权没法搬，只能在新平台重新连。这里记下名字和怎么连，用途一栏自己补一句。密钥都打了码，原值要从密码管理器里找。

## MCP 服务

${mcpMarkdown(mcpList)}
## 插件

${pluginList.length ? pluginList.map((x) => `- ${x.tool}：${x.name}`).join("\n") : "（没找到）"}

## 网页版的连接器

claude.ai、chatgpt.com 网页里连的东西（Google Drive、Gmail、Notion…）本机读不到，去设置里截图放进这个文件夹。
`);

// ======================= 聊天目录 =======================
index.sort((a, b) => (a.day < b.day ? 1 : -1));
put(join("聊天", "目录.md"), `# 聊天目录

一共 ${index.length} 个对话，最新的在最上面。每个对话一份 Markdown；原始文件在「原始文件」里。

| 日期 | 来源 | 项目 | 标题 | 几条 |
| --- | --- | --- | --- | --- |
${index.map((x) => `| ${x.day} | ${x.tool} | ${x.proj} | [${x.title.replace(/\s+/g, " ").slice(0, 40).replace(/\|/g, "\\|").replace(/[\[\]]/g, "")}](${encodeURI(relative("聊天", x.rel))}) | ${x.n} |`).join("\n")}
`);

// ======================= 交接素材 =======================
let handoffText = "";
let corrections = [];
for (const [key, list] of handoff) {
  list.sort((a, b) => (a.conv.start < b.conv.start ? -1 : 1));
  const body = list.map(({ conv, rel, lines }) => {
    const ls_ = lines.map((l) => `- ${l.at ? l.at.slice(0, 10) + " " : ""}${l.correction ? "【纠正】" : ""}${l.text.replace(/\n+/g, " ")}`).join("\n");
    for (const l of lines) if (l.correction) corrections.push({ key, conv, rel, l });
    return `### ${conv.title}\n来源：${rel}\n\n${ls_}`;
  }).join("\n\n");
  const text = `# ${key}：我说过的话\n\n最近 ${MONTHS} 个月，只有我自己说的话（AI 的回答和工具输出都去掉了），给写交接用。\n\n${body}\n`;
  handoffText += text;
  put(join("交接", "素材", `${safeName(key.replace(" · ", "-"), 60)}.md`), text);
}
corrections.sort((a, b) => (a.l.at < b.l.at ? 1 : -1));
const corrText = `# 纠正记录\n\n我纠正 AI、要求重写的句子（按关键词挑的，可能有误），每条带 AI 上一句的开头。给写「正反例清单」用。\n\n${corrections.map(({ key, rel, l }) => `## ${l.at.slice(0, 10)} · ${key}\n- AI 上一句：${l.before || "（无）"}\n- 我说：${l.text.replace(/\n+/g, " ")}\n- 来源：${rel}`).join("\n\n")}\n`;
put(join("交接", "素材", "纠正记录.md"), corrText);
handoffText += corrText;
put(join("交接", "写交接的咒语.md"), handoffGuide());
put(join("交接", "迁入提示词.md"), moveInGuide());
const handoffTokens = estimateTokens(handoffText);

// ======================= 账号数据（云端） =======================
put(join("账号数据", "去哪导出.md"), `# 云端的家当去哪导出

这些东西在服务器上，本机读不到。照下面去官网点导出，下载的 ZIP 原样放进这个文件夹。

| 来源 | 家当 | 怎么导 |
| --- | --- | --- |
${CLOUD.map((c) => `| ${c.tool} | ${c.what} | ${c.where}（[打开](${c.url})） |`).join("\n")}
`);
for (const f of ls(join(OUT, "账号数据"))) {
  if (!/\.zip$/i.test(f)) continue;
  if (/claude|anthropic/i.test(f)) counts.账号数据.Claude++;
  else counts.账号数据.Codex++;
}

// ======================= 说明 =======================
const now = new Date();
const cell = (n, have) => (!have ? "没装" : n ? `${n}` : "—");
const KINDS = [
  ["记忆", "记忆", "记忆"],
  ["聊天", "聊天", "聊天"],
  ["账号数据", "账号数据", "账号数据（官网导出的 ZIP 放这里）"],
  ["Skill", "Skills", "自建 Skill、子 agent、命令、提示词"],
  ["指令", "指令", "个人指令和每个项目的指令"],
  ["连接器", "连接器和插件", "连接器和插件清单（密钥已打码）"],
  ["附件", "附件", "附件和成果文件"],
];
put("说明.md", `# 搬家包

收于 ${now.toLocaleString("zh-CN", { hour12: false })}。Claude：${haveClaude ? "找到了" : "这台电脑没有"}；Codex：${haveCodex ? "找到了" : "这台电脑没有"}。

| 家当 | 文件夹 | Claude | Codex |
| --- | --- | --- | --- |
${KINDS.map(([k, dir, label]) => `| ${label} | ${dir}/ | ${cell(counts[k].Claude, haveClaude)} | ${cell(counts[k].Codex, haveCodex)} |`).join("\n")}

数字是个数，“—”是这台电脑上没有。

## 还要你自己做的

1. **云端的家当**：网页版 Claude、ChatGPT 的聊天、记忆、Skills、连接器在服务器上，照 \`账号数据/去哪导出.md\` 去官网导出，ZIP 放进 \`账号数据/\`。
2. **写交接**：照 \`交接/写交接的咒语.md\` 让 AI 写三份交接文档。素材在 \`交接/素材/\`，只有你说过的话，大约 ${handoffTokens < 1000 ? "不到 1k" : Math.round(handoffTokens / 1000) + "k"} token。
3. **搬进新家**：把整个文件夹交给新 AI，贴 \`交接/迁入提示词.md\` 里那段话。

## 没带的

- 登录凭证（auth.json、令牌）：故意不带，换号要重新登录。配置里的密钥都打了码。
- 网页版对话里的上传文件和工件：在官网导出包里。
- 聊天里你自己贴过的密码、密钥不会被打码。这个文件夹要发给别人或传到网上之前，先搜一下。
- 本地项目文件夹：只记了路径（\`指令/项目/*/项目路径.txt\`），文件还在原处。
${notes.length ? `\n## 注意\n\n${notes.map((n) => `- ${n}`).join("\n")}\n` : ""}
## 文件夹

- \`聊天/\`：每个对话一份 Markdown，\`聊天/目录.md\` 是总目录
- \`原始文件/\`：原样的对话文件，导进别的工具时用
- 其他见上表
`);

// ======================= 打包 =======================
let zipPath = "";
if (ZIP) {
  zipPath = `${OUT.replace(/\/+$/, "")}-${now.toISOString().slice(0, 10)}.zip`;
  try {
    if (process.platform === "darwin") execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", OUT, zipPath]);
    else execFileSync("zip", ["-qr", zipPath, basename(OUT)], { cwd: dirname(OUT) });
  } catch (e) { notes.push(`打包没成功：${e.message}`); zipPath = ""; }
}

// ======================= 状态（页面读） =======================
const summary = {
  at: now.toISOString(),
  out: OUT,
  zip: zipPath,
  have: { Claude: haveClaude, Codex: haveCodex },
  counts,
  conversations: index.length,
  handoff: { months: MONTHS, tokens: handoffTokens, projects: handoff.size, corrections: corrections.length },
  written,
  notes,
};
if (DATA) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, "状态.json"), JSON.stringify(summary, null, 2) + "\n");
}
console.log(JSON.stringify(summary, null, 2));
