#!/usr/bin/env node
/**
 * server.mjs — dsh-memory MCP server（stdio，零外部依赖）
 *
 * 用法（一般由 dsh 通过 @deepseek-ai/dsh-mcp-client 拉起）：
 *   node server.mjs
 *
 * 环境变量：
 *   MEMORY_DIR                记忆目录，默认 $DSH_HOME/memory 或 ~/.dsh/memory
 *   MEMORY_INSTRUCTIONS_MAX   注入系统提示的核心记忆字节上限，默认 12000（dsh 上限 32768）
 *   MEMORY_LOG_LEVEL          debug | info | warn | error，默认 warn。日志一律走 stderr。
 *
 * 注意：stdout 只允许输出 JSON-RPC，任何调试信息必须写 stderr。
 */

import readline from 'node:readline';
import {
  ensureLayout,
  resolveMemoryDir,
  buildInstructions,
  search,
  getExcerpt,
  save,
  listFiles,
  stats,
} from './memory-core.mjs';

const SERVER_INFO = { name: 'dsh-memory', version: '0.1.0' };
const SUPPORTED_PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const FALLBACK_PROTOCOL = '2025-06-18';

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = LOG_LEVELS[(process.env.MEMORY_LOG_LEVEL || 'warn').toLowerCase()] ?? 30;
function log(level, ...args) {
  if ((LOG_LEVELS[level] ?? 30) >= LOG_LEVEL) {
    process.stderr.write(`[dsh-memory ${level}] ${args.join(' ')}\n`);
  }
}

const MEMORY_DIR = resolveMemoryDir();
const INSTRUCTIONS_MAX = Number(process.env.MEMORY_INSTRUCTIONS_MAX || 12000);

const TOOLS = [
  {
    name: 'memory_search',
    description:
      '在持久记忆里检索。用于回答任何关于过去的事（做过什么、说过什么、偏好、决定、项目进度、环境事实）之前。' +
      '返回按相关度排序的片段，带 文件#line 定位。中文按短语匹配，英文按前缀匹配。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言或关键词查询，例如「锅炉 MATLAB 交付」' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 8' },
        corpus: {
          type: 'string',
          enum: ['all', 'memory', 'daily', 'dreams'],
          description: 'all=全部（默认）; memory=仅 MEMORY.md; daily=仅每日笔记; dreams=仅梦境日志',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get',
    description: '按行号读取某个记忆文件的原文片段。用于 memory_search 命中后确认细节。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对记忆目录的路径，如 MEMORY.md 或 memory/2026-10-28.md' },
        from: { type: 'integer', minimum: 1, description: '起始行号，默认 1' },
        lines: { type: 'integer', minimum: 1, maximum: 400, description: '读取行数，默认 60' },
      },
      required: ['path'],
    },
  },
  {
    name: 'memory_save',
    description:
      '写入记忆。默认追加到当日笔记（memory/YYYY-MM-DD.md）。' +
      '值得跨会话保留的事：用户偏好或纠正、项目决定与原因、踩坑与根因、环境事实、交付物位置。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容，一条一件事，写清背景与结论' },
        target: {
          type: 'string',
          enum: ['daily', 'memory'],
          description: 'daily=当日笔记（默认，推荐）; memory=长期 MEMORY.md（只放真正长期有效的结论）',
        },
        section: { type: 'string', description: 'target=memory 时可指定追加到哪个二级标题下，如「用户偏好」' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_list',
    description: '列出所有记忆文件（路径、大小、行数、修改时间）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_stats',
    description: '记忆库统计：文件数、索引块数、字节数。用于排查索引问题。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

function fmtSearch(rows, query) {
  if (!rows.length) {
    return `没有找到与「${query}」相关的记忆。可以换更短的关键词，或先用 memory_list 看有哪些文件。`;
  }
  const parts = rows.map((r, i) => {
    const head = r.heading ? `〔${r.heading}〕` : '';
    const body = r.body.length > 1200 ? r.body.slice(0, 1200) + '\n…（截断，用 memory_get 读全文）' : r.body;
    return `${i + 1}. ${r.path}#${r.lineStart} ${head}\n${body}`;
  });
  return `命中 ${rows.length} 条（Source: 文件#line）：\n\n` + parts.join('\n\n---\n\n');
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'memory_search': {
      const rows = await search(MEMORY_DIR, args.query, {
        limit: args.limit ?? 8,
        corpus: args.corpus ?? 'all',
      });
      return fmtSearch(rows, args.query);
    }
    case 'memory_get': {
      const r = getExcerpt(MEMORY_DIR, args.path, { from: args.from, lines: args.lines });
      return `Source: ${r.path}#${r.from}-${r.to}（共 ${r.totalLines} 行）\n\n${r.text}`;
    }
    case 'memory_save': {
      const r = await save(MEMORY_DIR, args.text, {
        target: args.target ?? 'daily',
        section: args.section ?? '',
      });
      return `已写入 ${r.path}${r.section ? `（章节：${r.section}）` : ''}，${r.bytes} 字节。`;
    }
    case 'memory_list': {
      const files = listFiles(MEMORY_DIR);
      if (!files.length) return '记忆目录还是空的。';
      return files.map((f) => `- ${f.path} — ${f.lines} 行 / ${f.bytes} 字节 / ${f.mtime}`).join('\n');
    }
    case 'memory_stats': {
      const s = await stats(MEMORY_DIR);
      return [
        `目录：${s.dir}`,
        `文件：${s.files} 个`,
        `索引块：${s.chunks}`,
        `记忆字节：${s.bytes}`,
        `索引大小：${s.indexBytes}`,
        `Node：${s.node}`,
      ].join('\n');
    }
    default:
      throw Object.assign(new Error(`未知工具：${name}`), { code: -32602 });
  }
}

async function handle(msg) {
  const { method, params, id } = msg;

  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL;
    let instructions;
    try {
      ensureLayout(MEMORY_DIR);
      instructions = buildInstructions(MEMORY_DIR, { maxBytes: INSTRUCTIONS_MAX });
    } catch (e) {
      log('error', '构建 instructions 失败:', e.message);
      instructions = undefined;
    }
    log('info', `initialize from ${params?.clientInfo?.name || 'unknown'}, protocol=${protocolVersion}`);
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      ...(instructions ? { instructions } : {}),
    };
  }

  if (method === 'ping') return {};

  if (method === 'tools/list') return { tools: TOOLS };

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      const text = await callTool(name, args);
      return textResult(text);
    } catch (e) {
      log('warn', `tool ${name} 失败:`, e.message);
      return textResult(`错误：${e.message}`, true);
    }
  }

  if (method === 'resources/list') return { resources: [] };
  if (method === 'resources/templates/list') return { resourceTemplates: [] };
  if (method === 'prompts/list') return { prompts: [] };
  if (method === 'logging/setLevel') return {};

  throw Object.assign(new Error(`不支持的方法：${method}`), { code: -32601 });
}

async function main() {
  try {
    ensureLayout(MEMORY_DIR);
  } catch (e) {
    log('error', `记忆目录不可用（${MEMORY_DIR}）：${e.message}`);
  }
  log('info', `启动，记忆目录 ${MEMORY_DIR}`);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    const raw = line.trim();
    if (!raw) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      fail(null, -32700, 'JSON 解析失败');
      return;
    }
    const list = Array.isArray(msg) ? msg : [msg];
    for (const m of list) {
      if (m.id === undefined || m.id === null) continue; // notification，无需响应
      try {
        const result = await handle(m);
        ok(m.id, result);
      } catch (e) {
        fail(m.id, e.code ?? -32603, e.message ?? String(e));
      }
    }
  });

  rl.on('close', () => {
    log('info', 'stdin 关闭，退出');
    process.exit(0);
  });

  const shutdown = () => process.exit(0);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  log('error', '致命错误:', e.stack || e.message);
  process.exit(1);
});