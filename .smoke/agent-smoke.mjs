#!/usr/bin/env node
// window.agent 契约冒烟（Tier 5）：真实页面 + 真实 Chrome 上验证契约与 baseline 一致。
// 仅在具备 Chrome 的环境手动/CI 调用：node .smoke/agent-smoke.mjs [--keep]
// 步骤：本地静态服务 → harness open（agent 会话）→ 求值契约 → 与 baseline 比对 → act 冒烟 → 截图。
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS = join(ROOT, 'agent', 'harness.mjs');
const BASELINE = JSON.parse(readFileSync(join(ROOT, '.smoke', 'agent-contract.baseline.json'), 'utf8'));
const KEEP = process.argv.includes('--keep');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.srt': 'text/plain; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function serve(root, port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      const file = resolve(join(root, '.' + path));
      if (!file.startsWith(resolve(root))) throw new Error('越界');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done(server)));
}

function harness(args) {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { encoding: 'utf8', timeout: 60000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function walkPaths(value, prefix = '', out = []) {
  if (Array.isArray(value)) {
    out.push(prefix + '[]');
    value.forEach((v) => walkPaths(v, `${prefix}[].`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    out.push(prefix);
    for (const [k, v] of Object.entries(value)) walkPaths(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.push(prefix);
  return out;
}

function die(message, extra = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...extra }));
  process.exit(2);
}

// 找空闲端口
async function freePort() {
  const { createServer: cs } = await import('node:net');
  return new Promise((done) => {
    const s = cs();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => done(port));
    });
  });
}

const chromePath = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  .map((n) => {
    const r = spawnSync('sh', ['-c', `command -v ${n}`], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  })
  .find(Boolean);
if (!chromePath) die('未找到 Chrome，无法跑真实页面冒烟（单测已覆盖契约形状）');

const httpPort = await freePort(); // 静态服务端口（与 CDP 调试端口必须分开）
const port = await freePort(); // CDP 调试端口
const subsAbs = `http://127.0.0.1:${httpPort}/.smoke/sample.srt`;
const pageUrl = `http://127.0.0.1:${httpPort}/?agent=1&subs=${encodeURIComponent(subsAbs)}`;
const profile = join(tmpdir(), `agent-smoke-${Date.now()}`);
const shotPath = join(ROOT, '.smoke', 'agent-smoke.png');

const server = await serve(ROOT, httpPort);
const problems = [];
let opened = false;
try {
  const open = harness(['open', '--url', pageUrl, '--port', String(port), '--chrome', chromePath, '--headless', '--profile', profile]);
  if (open.status !== 0) die('open 失败', { status: open.status, stdout: open.stdout, stderr: open.stderr });
  opened = true;

  // 等页面就绪：window.agent 可用且字幕已加载
  let snapshot = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const r = harness(['eval', '--port', String(port), 'window.agent ? JSON.stringify(window.agent.getSnapshot()) : null']);
    if (r.status === 0 && r.json?.ok && r.json.value) {
      snapshot = JSON.parse(r.json.value);
      if (snapshot.subtitle.count > 0) break;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  if (!snapshot?.subtitle?.count) problems.push('页面 30s 内未就绪（window.agent.getSnapshot 无字幕行）');

  // 契约表面与字段路径比对 baseline
  const surface = harness(['eval', '--port', String(port), 'JSON.stringify(Object.keys(window.agent))']);
  const apiKeys = JSON.parse(surface.json.value);
  if (JSON.stringify(apiKeys.slice().sort()) !== JSON.stringify(BASELINE.apiSurface)) {
    problems.push(`window.agent 表面漂移：${apiKeys.join(',')} ≠ baseline`);
  }
  if (snapshot) {
    const paths = [...new Set(walkPaths(snapshot))].sort();
    if (JSON.stringify(paths) !== JSON.stringify(BASELINE.snapshotPaths)) {
      problems.push('getSnapshot 字段路径与 baseline 不一致');
    }
  }

  // act 冒烟：全选后 selection 应含全部行
  const act = harness(['eval', '--port', String(port), 'window.agent.act("selectAll").then(() => window.agent.getSnapshot().selection.selectedIds.length)']);
  if (act.status !== 0 || act.json?.value !== snapshot.subtitle.count) {
    problems.push(`act(selectAll) 冒烟失败：${act.stdout || act.stderr}`);
  }

  // 截图存证
  const shot = harness(['shot', '--port', String(port), '--out', shotPath]);
  if (shot.status !== 0) problems.push(`shot 失败：${shot.stdout || shot.stderr}`);
  else if (!existsSync(shotPath)) problems.push('shot 报告成功但文件不存在');
} finally {
  if (opened && !KEEP) harness(['close', '--port', String(port)]);
  server.close();
  if (!KEEP) rmSync(profile, { recursive: true, force: true });
}

if (problems.length) {
  console.error(JSON.stringify({ ok: false, problems }, null, 2));
  process.exit(2);
}
console.log(JSON.stringify({ ok: true, note: `截图：${shotPath}` }));
