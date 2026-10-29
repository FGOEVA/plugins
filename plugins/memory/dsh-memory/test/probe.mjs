#!/usr/bin/env node
/**
 * probe.mjs — 自测：用一个假 MCP 客户端跑一遍真实协议
 *   node test/probe.mjs [memoryDir]
 * 逐项断言，任何一项失败退出码 1。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'server.mjs');
const memoryDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, MEMORY_DIR: memoryDir, MEMORY_LOG_LEVEL: 'error' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;
let failures = 0;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error('❌ stdout 出现非 JSON（协议污染）:', line.slice(0, 120));
    failures++;
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 15000);
  });
}

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`✅ ${name}`);
  } else {
    failures++;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log(`记忆目录：${memoryDir}\n`);

  // 0. 准备一份中文素材
  fs.mkdirSync(path.join(memoryDir, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, 'MEMORY.md'),
    '# MEMORY.md — 长期记忆\n\n## 用户\n- 用户叫 Gin，讲中文，时区 Asia/Shanghai。\n\n## 项目\n- 锅炉温度控制 MATLAB 单已交付，客户待反馈。\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(memoryDir, 'memory', '2026-10-28.md'),
    '# 2026-10-28\n\n- 调试 dsh 记忆插件，FTS5 中文检索跑通。\n',
    'utf8',
  );

  // 1. initialize
  const init = await rpc('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'probe', version: '1.0.0' },
  });
  check('initialize 返回协议版本', init.protocolVersion === '2026-07-28', init.protocolVersion);
  check('serverInfo 名称正确', init.serverInfo?.name === 'dsh-memory');
  check('注入 instructions 非空', typeof init.instructions === 'string' && init.instructions.length > 100);
  check('instructions 含核心记忆', (init.instructions || '').includes('Gin'));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 2. tools/list
  const tl = await rpc('tools/list', {});
  const names = (tl.tools || []).map((t) => t.name);
  check('tools/list 返回 5 个工具', names.length === 5, names.join(','));
  check('工具 schema 完整', (tl.tools || []).every((t) => t.description && t.inputSchema));

  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { text: r.content?.[0]?.text ?? '', isError: !!r.isError };
  };

  // 3. 中文检索（多字词组，验证 CJK 短语匹配）
  let r = await call('memory_search', { query: '锅炉' });
  check('中文检索命中「锅炉」', !r.isError && r.text.includes('锅炉'), r.text.slice(0, 80));
  check('结果带 文件#line 定位', /MEMORY\.md#\d+/.test(r.text));

  r = await call('memory_search', { query: '温度控制' });
  check('跨词中文短语命中', !r.isError && r.text.includes('锅炉温度控制'));

  r = await call('memory_search', { query: 'FTS5' });
  check('英文检索命中每日笔记', !r.isError && r.text.includes('daily') === false && r.text.includes('2026-10-28.md'));

  r = await call('memory_search', { query: '完全不存在的词汇xyzzy' });
  check('无命中时给出友好提示', !r.isError && r.text.includes('没有找到'));

  r = await call('memory_search', { query: 'Gin', corpus: 'memory' });
  check('corpus=memory 只搜 MEMORY.md', !r.isError && r.text.includes('MEMORY.md'));

  // 4. memory_get
  r = await call('memory_get', { path: 'MEMORY.md', from: 7, lines: 1 });
  check('memory_get 精确取行', r.text.includes('锅炉温度控制') && r.text.includes('#7-7'), r.text.slice(0, 60));
  r = await call('memory_get', { path: '../../etc/passwd' });
  check('memory_get 拦截路径穿越', r.isError);

  // 5. memory_save
  r = await call('memory_save', { text: '记住：部署 dsh 时 workspace 只给空目录，绝不给 /。' });
  check('memory_save 写入当日笔记', !r.isError && r.text.includes('memory/'));
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const todayFile = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.md`;
  const savedText = fs.readFileSync(path.join(memoryDir, 'memory', todayFile), 'utf8');
  check('写入内容已落盘', savedText.includes('绝不给 /'), todayFile);

  r = await call('memory_save', { text: '用户偏好：交付文件前必须实际验证。', target: 'memory', section: '用户' });
  check('memory_save 追加到指定章节', !r.isError && r.text.includes('用户'));
  const memAfter = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  check('章节内容写进了 MEMORY.md', memAfter.includes('必须实际验证'));
  check('章节追加没有破坏原有内容', memAfter.includes('锅炉温度控制'));

  // 新写入的内容要能立刻被检索到（索引增量更新）
  r = await call('memory_search', { query: '验证' });
  check('新写入内容立即可检索', !r.isError && r.text.includes('必须实际验证'));

  // 6. list / stats
  r = await call('memory_list', {});
  check('memory_list 列出文件', r.text.includes('MEMORY.md') && r.text.includes('memory/'));
  r = await call('memory_stats', {});
  check('memory_stats 返回块数', /索引块：\d+/.test(r.text));

  // 7. 未知工具 / 未知方法
  r = await call('memory_nope', {});
  check('未知工具报错而非崩溃', r.isError);
  try {
    await rpc('nope/method', {});
    check('未知方法返回错误', false);
  } catch {
    check('未知方法返回错误', true);
  }

  // 8. 进程仍在（没被搞崩）
  const ping = await rpc('ping', {});
  check('服务仍然存活', typeof ping === 'object');

  console.log(`\n${failures === 0 ? '🎉 全部通过' : `💥 ${failures} 项失败`}`);
  return failures;
}

main()
  .then((f) => {
    child.kill();
    process.exit(f === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('❌ 测试异常：', e.message);
    child.kill();
    process.exit(1);
  });