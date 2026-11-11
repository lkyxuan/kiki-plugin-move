// 网页版搬家：用户选 ~/.claude、~/.codex 文件夹，全在浏览器里处理，下载一个 zip。不上传任何东西。
import { zipSync, strToU8 } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
import { decompress } from "https://cdn.jsdelivr.net/npm/fzstd@0.1.1/esm/index.mjs";
import {
  parseClaude, parseCodex, toMarkdown, safeName, projectName, handoffLines, estimateTokens,
  maskObject, maskText, claudeMcp, codexMcp, mcpMarkdown, jsonl,
} from "../搬家宝/skills/banjia/core.mjs";
import { handoffGuide, moveInGuide, CLOUD } from "../搬家宝/skills/banjia/prompts.mjs";

const $ = (id) => document.getElementById(id);
const picked = { claude: null, codex: null, claudeJson: null };

/** input[webkitdirectory] 选的文件 → Map(去掉第一层文件夹名的相对路径 → File) */
function toMap(fileList) {
  const m = new Map();
  for (const f of fileList) {
    const rel = (f.webkitRelativePath || f.name).split("/").slice(1).join("/");
    if (rel) m.set(rel, f);
  }
  return m;
}

function bindPicker(inputId, key, labelId, check) {
  $(inputId).addEventListener("change", (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    if (key === "claudeJson") { picked.claudeJson = files[0]; $(labelId).textContent = `已选 ${files[0].name}`; return refresh(); }
    const m = toMap(files);
    const warn = check(m);
    picked[key] = m;
    $(labelId).textContent = warn || `已选，${m.size} 个文件`;
    $(labelId).classList.toggle("warn", !!warn);
    refresh();
  });
}
bindPicker("pickClaude", "claude", "claudeSt", (m) => ([...m.keys()].some((k) => k.startsWith("projects/")) ? "" : "这个文件夹里没有 projects/，选的可能不是 ~/.claude"));
bindPicker("pickCodex", "codex", "codexSt", (m) => ([...m.keys()].some((k) => k.startsWith("sessions/")) ? "" : "这个文件夹里没有 sessions/，选的可能不是 ~/.codex"));
bindPicker("pickClaudeJson", "claudeJson", "claudeJsonSt", () => "");

function refresh() { $("go").disabled = !(picked.claude || picked.codex); }

const SKIP = /(^|\/)(auth\.json|\.credentials\.json|credentials\.json|[^/]*\.lock|\.env[^/]*|[^/]*\.pem|[^/]*\.key|\.DS_Store)$/i;
const MAX_FILE = 100 * 1024 * 1024;

$("go").addEventListener("click", async () => {
  $("go").disabled = true;
  $("result").hidden = true;
  const say = (t) => { $("progress").textContent = t; };
  try {
    const out = {};
    const put = (p, text) => { out[p] = strToU8(text); };
    const copy = async (file, p) => {
      if (SKIP.test(p) || file.size > MAX_FILE) return false;
      out[p] = new Uint8Array(await file.arrayBuffer());
      return true;
    };
    const text = async (file) => {
      if (!file) return "";
      if (file.name.endsWith(".zst")) return new TextDecoder().decode(decompress(new Uint8Array(await file.arrayBuffer())));
      return file.text();
    };
    const counts = Object.fromEntries(["记忆", "聊天", "账号数据", "Skill", "指令", "连接器", "附件"].map((k) => [k, { Claude: 0, Codex: 0 }]));
    const index = [], handoff = new Map(), mcpList = [], plugins = [], notes = [];
    const names = new Map();
    const SINCE = Date.now() - 3 * 30 * 864e5;
    const folder = (cwd) => {
      if (projectName(cwd) === "普通聊天") cwd = "普通聊天";
      const base = safeName(projectName(cwd), 40);
      let n = base, i = 2;
      while (names.has(n) && names.get(n) !== cwd) n = `${base}-${i++}`;
      names.set(n, cwd);
      return n;
    };
    const addConv = (conv) => {
      if (!conv.messages.length) return;
      const tool = conv.tool === "Codex" ? "Codex" : "Claude Code";
      const proj = folder(conv.cwd), day = (conv.start || "").slice(0, 10) || "没有日期";
      const rel = `聊天/${tool}/${proj}/${day} ${safeName(conv.title)}${conv.id ? ` · ${conv.id.slice(0, 8)}` : ""}.md`;
      put(rel, toMarkdown(conv));
      index.push({ tool, proj, day, title: conv.title, rel, n: conv.messages.length });
      const t = Date.parse(conv.end || conv.start || "");
      if (!isNaN(t) && t >= SINCE) {
        const key = `${tool} · ${proj}`;
        if (!handoff.has(key)) handoff.set(key, []);
        handoff.get(key).push({ conv, rel, lines: handoffLines(conv) });
      }
    };
    const skillCount = (m, prefix) => new Set([...m.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]).filter((x) => x && !x.startsWith("."))).size;

    // ---------- Claude ----------
    const C = picked.claude;
    if (C) {
      const chats = [...C.keys()].filter((k) => /^projects\/[^/]+\/[^/]+\.jsonl$/.test(k));
      let i = 0;
      for (const k of chats) {
        say(`Claude 对话 ${++i}/${chats.length}`);
        const f = C.get(k);
        await copy(f, `原始文件/Claude/${k}`);
        const conv = parseClaude(await text(f), k.split("/").pop().replace(/\.jsonl$/, ""));
        if (conv.messages.length) counts.聊天.Claude++;
        addConv(conv);
      }
      for (const [k, f] of C) {
        const mem = k.match(/^projects\/([^/]+)\/memory\/(.+)$/);
        if (mem && (await copy(f, `记忆/Claude/${mem[1]}/${mem[2]}`))) counts.记忆.Claude++;
        if (/^(skills|agents|commands)\//.test(k)) await copy(f, `Skills/Claude/${k}`);
        if (/^(rules|output-styles)\//.test(k) && (await copy(f, `指令/Claude/${k}`))) counts.指令.Claude++;
      }
      counts.Skill.Claude = skillCount(C, "skills/") + skillCount(C, "agents/") + skillCount(C, "commands/");
      for (const f of ["CLAUDE.md", "CLAUDE.local.md"]) if (C.has(f) && (await copy(C.get(f), `指令/Claude/个人-${f}`))) counts.指令.Claude++;
      if (C.has("history.jsonl")) await copy(C.get("history.jsonl"), "原始文件/Claude/history.jsonl");
      if (C.has("settings.json")) { try { put("连接器和插件/Claude-settings（已打码）.json", JSON.stringify(maskObject(JSON.parse(await text(C.get("settings.json")))), null, 2) + "\n"); } catch {} }
      if (C.has("plugins/installed_plugins.json")) {
        try { const j = JSON.parse(await text(C.get("plugins/installed_plugins.json"))); for (const n of Object.keys(j.plugins || j)) if (n !== "version") plugins.push({ tool: "Claude Code", name: n }); } catch {}
      }
    }
    if (picked.claudeJson) {
      try {
        const cj = JSON.parse(await picked.claudeJson.text());
        mcpList.push(...claudeMcp(cj).map((x) => ({ ...x, tool: "Claude Code" })));
        const keep = { mcpServers: cj.mcpServers || {}, projects: Object.fromEntries(Object.entries(cj.projects || {}).filter(([, v]) => v?.mcpServers && Object.keys(v.mcpServers).length).map(([k, v]) => [k, { mcpServers: v.mcpServers }])) };
        put("连接器和插件/Claude-mcp（已打码）.json", JSON.stringify(maskObject(keep), null, 2) + "\n");
      } catch { notes.push(".claude.json 读不出来，跳过了 MCP 清单。"); }
    }
    counts.连接器.Claude = mcpList.length + plugins.length;

    // ---------- Codex ----------
    const X = picked.codex;
    if (X) {
      const titles = {};
      for (const o of jsonl(await text(X.get("session_index.jsonl")))) if (o.id && o.thread_name) titles[o.id] = o.thread_name;
      for (const f of ["session_index.jsonl", "history.jsonl"]) if (X.has(f)) await copy(X.get(f), `原始文件/Codex/${f}`);
      const chats = [...X.keys()].filter((k) => /^(sessions|archived_sessions)\/.*\.jsonl(\.zst)?$/.test(k));
      let i = 0;
      for (const k of chats) {
        say(`Codex 对话 ${++i}/${chats.length}`);
        const f = X.get(k);
        await copy(f, `原始文件/Codex/${k}`);
        let t;
        try { t = await text(f); } catch { notes.push(`有个 Codex 对话解不开：${k}`); continue; }
        const conv = parseCodex(t, k.split("/").pop().replace(/\.jsonl(\.zst)?$/, ""), titles);
        if (conv.messages.length) counts.聊天.Codex++;
        addConv(conv);
      }
      for (const [k, f] of X) {
        if (k.startsWith("memories/") && (await copy(f, `记忆/Codex/${k.slice(9)}`))) counts.记忆.Codex++;
        if (/^memories.*\.sqlite$/.test(k)) await copy(f, `原始文件/Codex/${k}`);
        if (/^(skills|prompts)\/(?!\.)/.test(k)) await copy(f, `Skills/Codex/${k}`);
        if (k.startsWith("rules/") && (await copy(f, `指令/Codex/${k}`))) counts.指令.Codex++;
        if (k.startsWith("attachments/") && (await copy(f, `附件/Codex/${k.slice(12)}`))) counts.附件.Codex++;
      }
      counts.Skill.Codex = skillCount(X, "skills/") + skillCount(X, "prompts/");
      for (const f of ["AGENTS.md", "AGENTS.override.md", "instructions.md"]) if (X.has(f) && (await copy(X.get(f), `指令/Codex/个人-${f}`))) counts.指令.Codex++;
      if (X.has("config.toml")) {
        const toml = await text(X.get("config.toml"));
        put("连接器和插件/Codex-config（已打码）.toml", maskText(toml));
        const list = codexMcp(toml).map((x) => ({ ...x, tool: "Codex" }));
        mcpList.push(...list);
        counts.连接器.Codex += list.length;
      }
      for (const n of new Set([...X.keys()].filter((k) => k.startsWith("plugins/")).map((k) => k.split("/")[1]))) {
        if (n && n !== "cache" && !n.startsWith(".")) { plugins.push({ tool: "Codex", name: n }); counts.连接器.Codex++; }
      }
    }

    say("整理目录和交接素材…");
    put("连接器和插件/清单.md", `# 连接器和插件清单\n\n连接器的授权没法搬，只能在新平台重新连。密钥都打了码。\n\n## MCP 服务\n\n${mcpMarkdown(mcpList)}\n## 插件\n\n${plugins.map((x) => `- ${x.tool}：${x.name}`).join("\n") || "（没找到）"}\n\n## 网页版的连接器\n\nclaude.ai、chatgpt.com 里连的东西本机读不到，去设置里截图放进这个文件夹。\n`);
    index.sort((a, b) => (a.day < b.day ? 1 : -1));
    put("聊天/目录.md", `# 聊天目录\n\n一共 ${index.length} 个对话，最新的在最上面。\n\n| 日期 | 来源 | 项目 | 标题 | 几条 |\n| --- | --- | --- | --- | --- |\n${index.map((x) => `| ${x.day} | ${x.tool} | ${x.proj} | [${x.title.replace(/\s+/g, " ").slice(0, 40).replace(/[|\[\]]/g, " ")}](${encodeURI(x.rel.slice(3))}) | ${x.n} |`).join("\n")}\n`);

    let all = "", corr = [];
    for (const [key, list] of handoff) {
      const body = list.map(({ conv, rel, lines }) => {
        for (const l of lines) if (l.correction) corr.push({ key, rel, l });
        return `### ${conv.title}\n来源：${rel}\n\n${lines.map((l) => `- ${l.at ? l.at.slice(0, 10) + " " : ""}${l.correction ? "【纠正】" : ""}${l.text.replace(/\n+/g, " ")}`).join("\n")}`;
      }).join("\n\n");
      const t = `# ${key}：我说过的话\n\n最近 3 个月，只有我自己说的话，给写交接用。\n\n${body}\n`;
      all += t;
      put(`交接/素材/${safeName(key.replace(" · ", "-"), 60)}.md`, t);
    }
    corr.sort((a, b) => (a.l.at < b.l.at ? 1 : -1));
    const ct = `# 纠正记录\n\n我纠正 AI、要求重写的句子（按关键词挑的），每条带 AI 上一句的开头。\n\n${corr.map(({ key, rel, l }) => `## ${l.at.slice(0, 10)} · ${key}\n- AI 上一句：${l.before || "（无）"}\n- 我说：${l.text.replace(/\n+/g, " ")}\n- 来源：${rel}`).join("\n\n")}\n`;
    put("交接/素材/纠正记录.md", ct);
    all += ct;
    put("交接/写交接的咒语.md", handoffGuide());
    put("交接/迁入提示词.md", moveInGuide());
    const tokens = estimateTokens(all);
    put("账号数据/去哪导出.md", `# 云端的家当去哪导出\n\n这些在服务器上，本机读不到。去官网点导出，下载的 ZIP 放进这个文件夹。\n\n| 来源 | 家当 | 怎么导 |\n| --- | --- | --- |\n${CLOUD.map((c) => `| ${c.tool} | ${c.what} | ${c.where}（[打开](${c.url})） |`).join("\n")}\n`);

    const have = { Claude: !!C, Codex: !!X };
    const cell = (n, h) => (!h ? "没选" : n ? `${n}` : "—");
    const KINDS = [["记忆", "记忆"], ["聊天", "聊天"], ["账号数据", "账号数据（官网导出的 ZIP 放这里）"], ["Skill", "自建 Skill、子 agent、命令、提示词"], ["指令", "个人指令"], ["连接器", "连接器和插件清单"], ["附件", "附件"]];
    const table = `| 家当 | Claude | Codex |\n| --- | --- | --- |\n${KINDS.map(([k, l]) => `| ${l} | ${cell(counts[k].Claude, have.Claude)} | ${cell(counts[k].Codex, have.Codex)} |`).join("\n")}`;
    put("说明.md", `# 搬家包\n\n收于 ${new Date().toLocaleString("zh-CN", { hour12: false })}（网页版）。\n\n${table}\n\n## 还要你自己做的\n\n1. 云端的家当：照 \`账号数据/去哪导出.md\` 去官网导出。\n2. 写交接：照 \`交接/写交接的咒语.md\` 让 AI 写三份交接文档，素材在 \`交接/素材/\`，大约 ${tokens < 1000 ? "不到 1k" : Math.round(tokens / 1000) + "k"} token。\n3. 搬进新家：把整个文件夹交给新 AI，贴 \`交接/迁入提示词.md\`。\n\n## 没带的\n\n- 登录凭证：故意不带。配置里的密钥打了码。\n- 聊天里你自己贴过的密码、密钥不会被打码，发给别人之前先搜一下。\n- 项目文件夹里的 CLAUDE.md / AGENTS.md：网页版读不到，用 Kiki 搬家宝或命令行版能收。\n${notes.length ? `\n## 注意\n\n${notes.map((n) => `- ${n}`).join("\n")}\n` : ""}\n想让 AI 自动写交接、每周自动备份：用 Kiki 的搬家宝。\n`);

    say("打包…");
    const date = new Date().toISOString().slice(0, 10);
    const zipped = zipSync(Object.fromEntries(Object.entries(out).map(([k, v]) => [`搬家-${date}/${k}`, v])), { level: 6 });
    const url = URL.createObjectURL(new Blob([zipped], { type: "application/zip" }));
    const a = $("download");
    a.href = url;
    a.download = `搬家-${date}.zip`;
    $("summary").innerHTML = `<table><tr><th>家当</th><th>Claude</th><th>Codex</th></tr>${KINDS.map(([k, l]) => `<tr><td>${l}</td><td>${cell(counts[k].Claude, have.Claude)}</td><td>${cell(counts[k].Codex, have.Codex)}</td></tr>`).join("")}</table>
      <p class="meta">${index.length} 个对话 · 压缩包 ${(zipped.length / 1048576).toFixed(1)} MB · 写交接素材大约 ${tokens < 1000 ? "不到 1k" : Math.round(tokens / 1000) + "k"} token</p>`;
    $("result").hidden = false;
    say("");
    a.click();
  } catch (e) {
    say(`出错了：${e.message}`);
  } finally {
    $("go").disabled = false;
  }
});
