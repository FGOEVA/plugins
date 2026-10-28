/**
 * memory-core.mjs — 记忆内核（零外部依赖）
 *
 * 数据格式与 OpenClaw 兼容：
 *   <MEMORY_DIR>/MEMORY.md            长期记忆（人可读的 markdown）
 *   <MEMORY_DIR>/memory/YYYY-MM-DD.md 每日笔记
 *   <MEMORY_DIR>/dreams/              梦境整理日志与备份
 *   <MEMORY_DIR>/.index.sqlite        FTS5 检索索引（可随时删掉重建）
 *
 * 只用 Node 内置模块：node:fs / node:path / node:sqlite
 * 中文检索：把 CJK 逐字加空格写入索引列 cjk，查询侧同样处理，等价 bigram 短语匹配。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 单文件索引上限 2MB
const MAX_CHUNK = 1400;                 // 每块最大字符数

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const TOKEN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[A-Za-z0-9_]+/g;

/* ------------------------------------------------------------------ */
/* 路径与配置                                                          */
/* ------------------------------------------------------------------ */

export function resolveMemoryDir(explicit) {
  const cand = explicit
    || process.env.MEMORY_DIR
    || process.env.DSH_MEMORY_DIR
    || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory');
  return path.resolve(cand);
}

export function ensureLayout(dir) {
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dreams'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dreams', 'backups'), { recursive: true });
  const mem = path.join(dir, 'MEMORY.md');
  if (!fs.existsSync(mem)) {
    fs.writeFileSync(mem, '# MEMORY.md — 长期记忆\n\n<!-- 这里放跨会话都要记得的事。人可读，可手改。 -->\n', 'utf8');
  }
  return dir;
}

export function indexPath(dir) {
  return path.join(dir, '.index.sqlite');
}

export function todayStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* markdown 分块                                                       */
/* ------------------------------------------------------------------ */

export function chunkMarkdown(relPath, text) {
  const lines = text.split('\n');
  const chunks = [];
  let buf = [];
  let bufStart = 1;
  let headings = [];
  let len = 0;

  const flush = () => {
    if (!buf.length) return;
    const body = buf.join('\n').trim();
    if (body) {
      chunks.push({
        path: relPath,
        lineStart: bufStart,
        heading: headings.filter(Boolean).join(' > '),
        body,
      });
    }
    buf = [];
    len = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      headings = headings.slice(0, level - 1);
      headings[level - 1] = h[2].trim();
      bufStart = i + 1;
    }
    if (!buf.length) bufStart = i + 1;
    buf.push(line);
    len += line.length + 1;
    if (len >= MAX_CHUNK && line.trim() === '') flush();
  }
  flush();
  return chunks;
}

export function cjkSpaced(s) {
  return s.replace(CJK_RE, (m) => Array.from(m).join(' '));
}

/** 把自然语言查询转成 FTS5 查询串（默认 AND，可切 OR）。 */
export function ftsQuery(q, { or = false } = {}) {
  const parts = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(q))) {
    const tok = m[0];
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(tok)) {
      const chars = Array.from(tok);
      parts.push(chars.length === 1 ? `"${chars[0]}"` : `"${chars.join(' ')}"`);
    } else {
      parts.push(`${tok.toLowerCase()}*`);
    }
  }
  if (!parts.length) return null;
  return parts.join(or ? ' OR ' : ' AND ');
}

/* ------------------------------------------------------------------ */
/* 文件遍历                                                            */
/* ------------------------------------------------------------------ */

function walkMarkdown(dir, sub = '') {
  const out = [];
  const abs = path.join(dir, sub);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = sub ? path.join(sub, e.name) : e.name;
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      out.push(...walkMarkdown(dir, rel));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      out.push(rel);
    }
  }
  return out;
}

export function listMemoryFiles(dir) {
  return walkMarkdown(dir).sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------------------ */
/* 索引                                                                */
/* ------------------------------------------------------------------ */

async function openDbAsync(dir) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (e) {
    throw new Error(
      `node:sqlite 不可用（Node ${process.version}）：需要 Node.js >= 22.13，旧版本请用 \`node --experimental-sqlite\` 启动。原始错误：${e.message}`,
    );
  }
  const db = new DatabaseSync(indexPath(dir));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS files(
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      chunks INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      path UNINDEXED,
      line_start UNINDEXED,
      heading,
      body,
      cjk,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
  return db;
}

let _db = null;
async function db(dir) {
  if (!_db) _db = await openDbAsync(dir);
  return _db;
}

export async function closeIndex() {
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
  }
}

function indexOne(db, dir, rel) {
  const abs = path.join(dir, rel);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { indexed: false, reason: 'missing' };
  }
  const known = db.prepare('SELECT mtime, size FROM files WHERE path = ?').get(rel);
  if (known && known.mtime === Math.floor(st.mtimeMs) && known.size === st.size) {
    return { indexed: false, reason: 'clean' };
  }
  if (st.size > MAX_FILE_BYTES) return { indexed: false, reason: 'too-large' };

  const text = fs.readFileSync(abs, 'utf8');
  const chunks = chunkMarkdown(rel.replaceAll(path.sep, '/'), text);

  db.prepare('DELETE FROM chunks WHERE path = ?').run(rel);
  const ins = db.prepare('INSERT INTO chunks(path, line_start, heading, body, cjk) VALUES (?,?,?,?,?)');
  for (const c of chunks) {
    ins.run(c.path, c.lineStart, c.heading, c.body, cjkSpaced(`${c.heading}\n${c.body}`));
  }
  db.prepare(
    'INSERT INTO files(path, mtime, size, chunks) VALUES (?,?,?,?) ' +
    'ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, chunks=excluded.chunks',
  ).run(rel, Math.floor(st.mtimeMs), st.size, chunks.length);
  return { indexed: true, chunks: chunks.length };
}

/** 增量同步索引；force=true 时整库重建。 */
export async function syncIndex(dir, { force = false } = {}) {
  ensureLayout(dir);
  const dbh = await db(dir);
  const files = listMemoryFiles(dir);
  let added = 0;
  let total = 0;

  dbh.exec('BEGIN');
  try {
    if (force) {
      dbh.exec('DELETE FROM chunks; DELETE FROM files;');
    }
    for (const rel of files) {
      const r = indexOne(dbh, dir, rel);
      if (r.indexed) added++;
      total += r.chunks || 0;
    }
    const present = new Set(files);
    for (const row of dbh.prepare('SELECT path FROM files').all()) {
      if (!present.has(row.path)) {
        dbh.prepare('DELETE FROM chunks WHERE path = ?').run(row.path);
        dbh.prepare('DELETE FROM files WHERE path = ?').run(row.path);
      }
    }
    dbh.exec('COMMIT');
  } catch (e) {
    try { dbh.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return { files: files.length, reindexed: added, chunks: total };
}

/* ------------------------------------------------------------------ */
/* 检索                                                                */
/* ------------------------------------------------------------------ */

export async function search(dir, query, { limit = 8, corpus = 'all' } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 不能为空');
  await syncIndex(dir);
  const dbh = await db(dir);

  const where = [];
  const params = [];
  if (corpus === 'memory') where.push("path = 'MEMORY.md'");
  else if (corpus === 'daily') where.push("path LIKE 'memory/%'");
  else if (corpus === 'dreams') where.push("path LIKE 'dreams/%'");
  const clause = where.length ? ` AND (${where.join(' OR ')})` : '';

  const run = (matchStr) => {
    const sql =
      `SELECT path, line_start, heading, body, bm25(chunks) AS score
       FROM chunks WHERE chunks MATCH ?${clause}
       ORDER BY score LIMIT ?`;
    return dbh.prepare(sql).all(matchStr, Math.max(1, Math.min(50, limit)));
  };

  let rows = [];
  const andQ = ftsQuery(q);
  if (andQ) {
    try { rows = run(andQ); } catch { rows = []; }
  }
  if (!rows.length) {
    const orQ = ftsQuery(q, { or: true });
    if (orQ) {
      try { rows = run(orQ); } catch { rows = []; }
    }
  }
  return rows.map((r) => ({
    path: r.path,
    lineStart: r.line_start,
    heading: r.heading || '',
    body: r.body,
    score: -r.score, // bm25 越小越相关，翻成正数方便展示
  }));
}

export function getExcerpt(dir, relPath, { from = 1, lines = 60 } = {}) {
  const safe = path
    .normalize(String(relPath || ''))
    .replace(/^([/\\]|\.\.[/\\])+/, '');
  const abs = path.resolve(dir, safe);
  if (!abs.startsWith(path.resolve(dir) + path.sep) && abs !== path.resolve(dir)) {
    throw new Error(`路径越界：${relPath}`);
  }
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${safe}`);
  const all = fs.readFileSync(abs, 'utf8').split('\n');
  const start = Math.max(1, Number(from) || 1);
  const count = Math.max(1, Math.min(400, Number(lines) || 60));
  const slice = all.slice(start - 1, start - 1 + count);
  return {
    path: safe.replaceAll(path.sep, '/'),
    totalLines: all.length,
    from: start,
    to: start - 1 + slice.length,
    text: slice.join('\n'),
  };
}

function atomicWrite(abs, text) {
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, abs);
}

function timeStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 追加记忆。target=daily 写当日笔记；target=memory 写 MEMORY.md。 */
export async function save(dir, text, { target = 'daily', section = '' } = {}) {
  ensureLayout(dir);
  const body = String(text || '').trim();
  if (!body) throw new Error('text 不能为空');
  if (body.length > 20000) throw new Error('text 过长（上限 20000 字符）');

  const stamp = timeStamp();
  const date = todayStamp();

  if (target === 'memory') {
    const abs = path.join(dir, 'MEMORY.md');
    let cur = fs.readFileSync(abs, 'utf8');
    const block = body.includes('\n')
      ? `\n### ${stamp}\n\n${body}\n`
      : `\n- **${stamp}** ${body}\n`;

    if (section) {
      const re = new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
      const m = re.exec(cur);
      if (m) {
        const insertAt = m.index + m[0].length;
        const nextH = /^##\s+/m;
        nextH.lastIndex = insertAt;
        const rest = cur.slice(insertAt);
        const nm = /^##\s+/m.exec(rest);
        const before = nm ? insertAt + nm.index : cur.length;
        cur = cur.slice(0, before) + block + '\n' + cur.slice(before);
      } else {
        cur += `\n## ${section}\n${block}`;
      }
    } else {
      cur += `\n## 记录 ${date}\n${block}`;
    }
    atomicWrite(abs, cur);
    await syncIndex(dir, { force: false });
    return { path: 'MEMORY.md', target, section: section || null, bytes: Buffer.byteLength(body) };
  }

  const rel = path.join('memory', `${date}.md`);
  const abs = path.join(dir, rel);
  const block = body.includes('\n')
    ? `\n## ${stamp}\n\n${body}\n`
    : `\n- **${stamp}** ${body}\n`;
  if (!fs.existsSync(abs)) {
    atomicWrite(abs, `# ${date}\n${block}`);
  } else {
    fs.appendFileSync(abs, block, 'utf8');
  }
  await syncIndex(dir, { force: false });
  return { path: rel.replaceAll(path.sep, '/'), target, bytes: Buffer.byteLength(body) };
}

export function listFiles(dir) {
  ensureLayout(dir);
  return listMemoryFiles(dir).map((rel) => {
    const abs = path.join(dir, rel);
    const st = fs.statSync(abs);
    const text = fs.readFileSync(abs, 'utf8');
    return {
      path: rel.replaceAll(path.sep, '/'),
      bytes: st.size,
      lines: text.split('\n').length,
      mtime: new Date(st.mtimeMs).toISOString(),
    };
  });
}

export async function stats(dir) {
  const info = await syncIndex(dir);
  const dbh = await db(dir);
  const chunkCount = dbh.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  const files = listMemoryFiles(dir);
  let bytes = 0;
  for (const f of files) bytes += fs.statSync(path.join(dir, f)).size;
  return {
    dir,
    files: info.files,
    chunks: chunkCount,
    bytes,
    indexBytes: fs.existsSync(indexPath(dir)) ? fs.statSync(indexPath(dir)).size : 0,
    node: process.version,
  };
}

/* ------------------------------------------------------------------ */
/* 注入给模型的 instructions                                            */
/* ------------------------------------------------------------------ */

export function coreExcerpt(dir, maxBytes = 6000) {
  const abs = path.join(dir, 'MEMORY.md');
  if (!fs.existsSync(abs)) return '';
  const text = fs.readFileSync(abs, 'utf8');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text.trim();

  // 超预算：按二级标题切段，优先保留靠前的段落
  const parts = text.split(/\n(?=##\s+)/);
  let out = '';
  for (const p of parts) {
    if (Buffer.byteLength(out + p, 'utf8') > maxBytes) break;
    out += p + '\n';
  }
  if (!out.trim()) {
    return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8') + '\n\n…（已截断）';
  }
  return out.trim() + '\n\n…（核心记忆已按预算截断，完整内容用 memory_get 读取 MEMORY.md）';
}

export function buildInstructions(dir, { maxBytes = 12000 } = {}) {
  const core = coreExcerpt(dir, Math.max(1000, Math.floor(maxBytes * 0.7)));
  return `# 持久记忆（dsh-memory）

你有跨会话的持久记忆，存放在 \`${dir}\`。记忆是纯 markdown 文件，人可读、可直接编辑。

## 什么时候用
- **回答任何关于过去的事之前**（之前做过什么、说过什么、偏好、决定、项目进度、用户名/路径/密钥位置），先调用 \`memory_search\` 检索，再决定要不要 \`memory_get\` 读原文。不要凭印象编造。
- **学到值得跨会话保留的事**（用户的偏好或纠正、项目决定与原因、踩过的坑与根因、环境事实、交付物位置），立刻调用 \`memory_save\`（默认写入当日笔记）。
- 用户明确说「记住」时，必须写，且写完回一句确认。
- 大段原文、完整报告不要塞进 MEMORY.md，写进文件后用一句话记位置。

## 工具
- \`memory_search(query, limit?, corpus?)\` — 关键词 + 中文短语检索，返回 \`文件#line\` 与摘要
- \`memory_get(path, from?, lines?)\` — 按行号读原文
- \`memory_save(text, target?, section?)\` — target=\`daily\`（默认，当日笔记）或 \`memory\`（长期记忆）
- \`memory_list()\` / \`memory_stats()\` — 查看有哪些记忆文件

## 核心记忆（自动注入）
${core || '（暂无）'}
`;
}