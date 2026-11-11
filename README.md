# 搬家宝（Kiki 插件）

把 Claude 和 Codex 里的东西收好、写好交接、搬到新地方。号被封之前能备份，被封之后也能从本机文件和官方导出包里救回大部分。

七类家当：记忆、聊天、账号数据、自建 Skill、个人和项目指令、连接器和插件、附件和成果文件。

## 装

在 Kiki 的宝库里点「搬家宝」，或者左栏「导入一个宝」贴这个仓库的 `搬家宝` 文件夹链接。

## 不装 Kiki 也能用

收家当的脚本只要 Node 18+，不联网、不用 AI：

```
git clone https://github.com/lkyxuan/kiki-plugin-move
node kiki-plugin-move/搬家宝/skills/banjia/collect.mjs --out ~/搬家 --zip
```

## 做了什么

1. **收本机家当**（脚本，不花 token）：读 `~/.claude`、`~/.claude.json`、`~/.codex`，每个对话转成一份 Markdown，Skill、指令、连接器清单归位，原始文件原样留一份。登录凭证不带，配置里的密钥打码。
2. **云端家当**：网页版 Claude、ChatGPT 的东西在服务器上，`账号数据/去哪导出.md` 列了每样去哪点导出。
3. **写交接**：三份交接文档（默认行为、项目交接、正反例）。素材只挑你自己说过的话，AI 的回答和工具输出全去掉，省 token。老号还在就让老 AI 写。
4. **搬进去**：迁入提示词交给新 AI；或者在 Kiki 里直接搬进宝。

## 文件

- `搬家宝/plugin.json`：插件信息，带每周一次的安静备份
- `搬家宝/AGENTS.md`：宝负责什么
- `搬家宝/skills/banjia/`：技能和脚本（`core.mjs` 纯转换函数，网页版也用这份）
- `搬家宝/page/index.html`：「搬家」页面
