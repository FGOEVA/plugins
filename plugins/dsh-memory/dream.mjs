#!/usr/bin/env node
/**
 * dream.mjs — 梦境整理（记忆固化）
 *
 * 做三件事：
 *   1. 读最近的每日笔记 + 当前 MEMORY.md（可选：dsh 会话日志）
 *   2. 调一个 OpenAI 兼容接口，让模型做「去重 / 合并 / 提炼教训 / 丢弃噪音」
 *   3. 写回 MEMORY.md（带备份 + 安全阈值），并把当天摘要追加到每日笔记
 *
 * 用法：
 *   node dream.mjs                      # 试运行：只生成提案，不改文件
 *   node dream.mjs --apply              # 真正写回（自动备份）
 *   node dream.mjs --days 7 --apply
 *   node dream.mjs --print-prompt       # 只打印将要发送的提示词（不需要 key）
 *   node dream.mjs --sessions ~/.dsh/sessions   # 额外读入 dsh 会话日志（实验性）
 *
 * 配置（优先级：命令行 > 环境变量 > <MEMORY_DIR>/config.json > 默认值）：
 *   MEMORY_DIR              记忆目录
 *   DREAM_API_KEY           API key（也接受 MEMORY_LLM_API_KEY / OPENAI_API_KEY）
 *   DREAM_BASE_URL          默认 https://dashscope.aliyuncs.com/compatible-mode/v1
 *   DREAM_MODEL             默认 deepseek-v4.1-flash-1017
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import {
  ensureLayout,
  resolveMemoryDir,
  todayStamp,
  syncIndex,
  closeIndex,
} from './memory-core.mjs';

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const out = { apply: false, days: null, model: null, baseUrl: null, apiKey: null, maxBytes: null, sessions: null, printPrompt: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--apply': out.apply = true; break;
      case '--dry-run': out.apply = false; break;
      case '--days': out.days = Number(next()); break;
      case '--model': out.model = next(); break;
      case '--base-url': out.baseUrl = next(); break;
      case '--api-key': out.apiKey = next(); break;
      case '--max-bytes': out.maxBytes = Number(next()); break;
      case '--sessions': out.sessions = next(); break;
      case '--print-prompt': out.printPrompt = true; break;
      case '--quiet': out.quiet = true; break;
      case '-h': case '--help': out.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`未知参数：${a}`);
    }
  }
  return out;
}

const HELP = `dream.mjs — 记忆梦境整理

  node dream.mjs [options]

  --apply              真正写回 MEMORY.md（默认只出提案）
  --days N             回看最近 N 天的每日笔记，默认 3
  --model NAME         模型名，默认 deepseek-v4.1-flash-1017
  --base-url URL       OpenAI 兼容接口，默认阿里云百炼
  --api-key KEY        API key（也可用环境变量 DREAM_API_KEY）
  --max-bytes N        MEMORY.md 写回后的字节上限，默认 40000
  --sessions DIR       额外读入 dsh 会话日志目录（实验性）
  --print-prompt       只打印提示词，不调模型
  --quiet              只输出错误
  -h, --help           本帮助
`;

function readConfigFile(dir) {
  const p = path.join(dir, 'config.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`config.json 解析失败：${e.message}`);
  }
}

/* ---------------------------- 会话日志 ---------------------------- */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function maybeDecompress(buf) {
  if (buf.length > 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try {
      return zlib.zstdDecompressSync(buf);
    } catch {
      return null;
    }
  }
  return buf;
}

function collectFiles(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(abs, out, depth + 1);
    else if (/\.(jsonl|jsonl\.zst|jsonl\.zstd|log|ndjson)$/i.test(e.name)) out.push(abs);
  }
  return out;
}

/** 从会话日志里粗提对话正文。格式未知时尽力而为，失败就跳过。 */
function extractTextFromSessions(sessionDir, maxBytes = 120000) {
  const files = collectFiles(sessionDir).sort();
  const tail = files.slice(-40); // 只看最近的若干文件
  const chunks = [];
  let used = 0;

  for (const f of tail) {
    if (used >= maxBytes) break;
    let buf;
    try {
      buf = maybeDecompress(fs.readFileSync(f));
    } catch {
      continue;
    }
    if (!buf) continue;
    const text = buf.toString('utf8');
    for (const line of text.split('\n')) {
      if (used >= maxBytes) break;
      const t = line.trim();
      if (!t) continue;
      let piece = '';
      if (t.startsWith('{')) {
        try {
          const o = JSON.parse(t);
          const cand =
            o?.message?.content ?? o?.content ?? o?.text ?? o?.data?.content ?? o?.delta?.content;
          if (typeof cand === 'string') piece = cand;
          else if (Array.isArray(cand)) piece = cand.map((c) => c?.text ?? '').join(' ');
        } catch {
          continue;
        }
      }
      if (!piece || piece.length < 8) continue;
      if (/^\s*[<[{]/.test(piece)) continue;
      chunks.push(piece.slice(0, 1200));
      used += piece.length;
    }
  }
  return chunks.join('\n---\n');
}

/* ----------------------------- 素材 ----------------------------- */

function recentDaily(dir, days) {
  const dailyDir = path.join(dir, 'memory');
  if (!fs.existsSync(dailyDir)) return [];
  const files = fs
    .readdirSync(dailyDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse();
  const cutoff = new Date(Date.now() - days * 86400000);
  const cutoffStr = todayStamp(cutoff);
  return files
    .filter((f) => f.replace('.md', '') >= cutoffStr)
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(dailyDir, f), 'utf8') }));
}

function buildPrompt({ memory, dailies, sessionText, maxBytes }) {
  const dailyBlock = dailies.length
    ? dailies
        .map((d) => `### ${d.name}\n${d.text.slice(0, 24000)}`)
        .join('\n\n')
    : '（最近没有每日笔记）';

  return `你是一个 agent 的记忆整理器，负责「梦境整理」：把最近几天的碎片记忆，梳理进长期记忆。

## 输入

### 当前长期记忆（MEMORY.md，共 ${Buffer.byteLength(memory)} 字节）
${memory}

### 最近的每日笔记
${dailyBlock}
${sessionText ? `\n### 会话日志摘录（原始对话，可能有噪音）\n${sessionText.slice(0, 40000)}\n` : ''}
## 任务

重写 MEMORY.md，要求：
1. **保留**所有仍然有效的长期事实：用户身份与偏好、环境与路径、可用资源、做过的决定及原因、踩过的坑与根因、对外交付物位置。
2. **合并**重复或近似重复的条目，同一主题只留一处。
3. **提炼**每日笔记里值得长期记住的结论；纯过程性、一次性的细节丢弃。
4. **过期信息要标注**，不要直接删（例如「2026-08 已失效」），除非明显是同一事实的旧版本。
5. **结构**：用二级标题分组（如「我是谁」「用户偏好」「技术环境」「项目」），保持 markdown 干净、可读。
6. **体积**：中文正文控制在约 ${Math.floor(maxBytes / 3)} 字以内（约 ${maxBytes} 字节）。宁可精炼，不要堆砌。
7. **不要编造**输入里没有的信息；不确定的写成「待确认」。
8. 保留原有开头的标题行（# 开头的那一行）。

## 输出

只输出一个 JSON 对象，不要任何解释、不要 markdown 代码围栏：

{
  "memory_md": "重写后的完整 MEMORY.md 文本",
  "digest": "给用户看的一句话：这次整理做了什么（合并了什么、新增了什么、什么已过期）",
  "promoted": ["从每日笔记提升进长期记忆的要点，最多 8 条"],
  "open_questions": ["需要用户确认的疑点，可为空数组"]
}`;
}

/* ---------------------------- 模型调用 ---------------------------- */

async function callModel({ baseUrl, apiKey, model, prompt, timeoutMs = 240000 }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是严谨的记忆整理器。只输出 JSON。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 8192,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`模型接口 ${res.status}：${text.slice(0, 400)}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`模型返回非 JSON：${text.slice(0, 300)}`);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(`模型返回为空：${JSON.stringify(data).slice(0, 300)}`);
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(text) {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('输出里找不到 JSON 对象');
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    // 常见瑕疵：字符串里裸换行。退而求其次做一次宽松修复
    const fixed = body.replace(/([^\\])\n/g, '$1\\n');
    return JSON.parse(fixed);
  }
}

/* ----------------------------- 写回 ----------------------------- */

function atomicWrite(abs, text) {
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, abs);
}

function checkMemoryGuard(newText, oldText, maxBytes) {
  const problems = [];
  const nb = Buffer.byteLength(newText, 'utf8');
  const ob = Buffer.byteLength(oldText, 'utf8');
  if (!newText.trim().startsWith('#')) problems.push('新文本没有以 Markdown 标题开头');
  if (nb > maxBytes) problems.push(`超出体积上限：${nb} > ${maxBytes} 字节`);
  if (ob > 0 && nb < ob * 0.4) {
    problems.push(`体积骤减：${ob} → ${nb} 字节（低于原体积 40%，疑似丢内容）`);
  }
  if (!/^#\s+/m.test(newText)) problems.push('缺少一级标题');
  return problems;
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const dir = ensureLayout(resolveMemoryDir());
  const cfg = readConfigFile(dir);
  const llm = cfg.llm || {};
  const dreamCfg = cfg.dream || {};

  const days = args.days ?? dreamCfg.days ?? 3;
  const maxBytes = args.maxBytes ?? dreamCfg.maxBytes ?? 40000;
  const baseUrl = args.baseUrl
    ?? process.env.DREAM_BASE_URL
    ?? llm.baseUrl
    ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const model = args.model ?? process.env.DREAM_MODEL ?? llm.model ?? 'deepseek-v4.1-flash-1017';
  const apiKey = args.apiKey
    ?? process.env.DREAM_API_KEY
    ?? process.env.MEMORY_LLM_API_KEY
    ?? process.env.OPENAI_API_KEY
    ?? (llm.apiKeyFile && fs.existsSync(llm.apiKeyFile)
      ? fs.readFileSync(llm.apiKeyFile, 'utf8').trim()
      : null)
    ?? (fs.existsSync(path.join(os.homedir(), '.dsh', 'memory-llm.key'))
      ? fs.readFileSync(path.join(os.homedir(), '.dsh', 'memory-llm.key'), 'utf8').trim()
      : null);

  const say = (...a) => { if (!args.quiet) console.log(...a); };

  const memoryPath = path.join(dir, 'MEMORY.md');
  const memory = fs.readFileSync(memoryPath, 'utf8');
  const dailies = recentDaily(dir, days);
  const sessionText = args.sessions ? extractTextFromSessions(args.sessions) : '';

  say(`记忆目录：${dir}`);
  say(`素材：MEMORY.md ${Buffer.byteLength(memory)} 字节，每日笔记 ${dailies.length} 篇` +
      (sessionText ? `，会话摘录 ${Buffer.byteLength(sessionText)} 字节` : ''));

  const prompt = buildPrompt({ memory, dailies, sessionText, maxBytes });

  if (args.printPrompt) {
    process.stdout.write(prompt + '\n');
    return 0;
  }

  if (!apiKey) {
    throw new Error(
      '缺少 API key：用 --api-key、环境变量 DREAM_API_KEY，或写入 ~/.dsh/memory-llm.key',
    );
  }

  say(`模型：${model} @ ${baseUrl}`);
  const raw = await callModel({ baseUrl, apiKey, model, prompt });
  const parsed = parseJsonLoose(raw);

  const newMemory = String(parsed.memory_md || '').trim();
  if (!newMemory) throw new Error('模型没有返回 memory_md');

  const date = todayStamp();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const proposalPath = path.join(dir, 'dreams', `${date}-proposal.md`);
  atomicWrite(proposalPath, newMemory + '\n');
  say(`提案已写入：${path.relative(dir, proposalPath)}`);

  const problems = checkMemoryGuard(newMemory, memory, maxBytes);
  if (problems.length) {
    say('\n⚠️  安全检查未通过，未写回：');
    for (const p of problems) say(`   - ${p}`);
    say('   提案文件已保留，可人工修改后手动应用。');
    return 1;
  }

  if (!args.apply) {
    say('\n（试运行）加 --apply 才会写回 MEMORY.md。');
    if (parsed.digest) say(`摘要：${parsed.digest}`);
    return 0;
  }

  // 备份
  const backup = path.join(dir, 'dreams', 'backups', `MEMORY-${stamp}.md`);
  fs.writeFileSync(backup, memory, 'utf8');
  atomicWrite(memoryPath, newMemory.endsWith('\n') ? newMemory : newMemory + '\n');

  // 摘要追加到当日笔记
  const dailyPath = path.join(dir, 'memory', `${date}.md`);
  const hhmm = new Date().toTimeString().slice(0, 5);
  const digestBlock = [
    '',
    `## 🌙 梦境整理 ${hhmm}`,
    '',
    parsed.digest ? `- 摘要：${parsed.digest}` : '- 已完成整理',
    ...(Array.isArray(parsed.promoted) && parsed.promoted.length
      ? ['- 提升进长期记忆：', ...parsed.promoted.map((x) => `  - ${x}`)]
      : []),
    ...(Array.isArray(parsed.open_questions) && parsed.open_questions.length
      ? ['- 待确认：', ...parsed.open_questions.map((x) => `  - ${x}`)]
      : []),
    '',
  ].join('\n');
  if (!fs.existsSync(dailyPath)) {
    fs.writeFileSync(dailyPath, `# ${date}\n${digestBlock}`, 'utf8');
  } else {
    fs.appendFileSync(dailyPath, digestBlock, 'utf8');
  }

  // 运行日志
  const logLine = `${new Date().toISOString()} apply=1 model=${model} in=${Buffer.byteLength(memory)} out=${Buffer.byteLength(newMemory)} backup=${path.relative(dir, backup)}\n`;
  fs.appendFileSync(path.join(dir, 'dreams', `${date}.log`), logLine, 'utf8');

  await syncIndex(dir, { force: false });
  await closeIndex();

  say(`✅ 已写回 MEMORY.md（${Buffer.byteLength(memory)} → ${Buffer.byteLength(newMemory)} 字节）`);
  say(`   备份：${path.relative(dir, backup)}`);
  if (parsed.digest) say(`   摘要：${parsed.digest}`);
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });