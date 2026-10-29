#!/usr/bin/env node
// Local web UI for browsing playground runs and starting new ones. Usage: node runner/serve.mjs [--port=4173]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, RESULTS_DIR, CASES_DIR, PLUGINS_OUT_DIR, loadConfig, redact, list } from './lib/env.mjs';
import { loadCases } from './lib/cases.mjs';

const UI_DIR = path.join(ROOT, 'ui');
const config = loadConfig();
const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.split('=')[1] : config.UI_PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.sarif': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const TEXT_EXT = new Set(['.txt', '.bal', '.toml', '.md', '.properties', '.log', '.tmpl', '.java', '']);

let job = null;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function within(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listRuns() {
  if (!fs.existsSync(RESULTS_DIR)) {
    return [];
  }
  return fs.readdirSync(RESULTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readJson(path.join(RESULTS_DIR, d.name, 'run.json')))
    .filter(Boolean)
    .sort((a, b) => b.id.localeCompare(a.id));
}

function directoryPage(rel, entries) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const base = `/files/${rel.split('/').map(encodeURIComponent).join('/')}/`;
  const rows = entries
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
    .map((e) => `<tr><td><a href="${base}${encodeURIComponent(e.name)}${e.dir ? '/' : ''}">${esc(e.name)}${e.dir ? '/' : ''}</a></td><td>${e.dir ? '' : `${e.size} B`}</td></tr>`)
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>${esc(rel)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#1c2024;background:#fff}td{padding:3px 14px 3px 0;font-family:ui-monospace,Consolas,monospace;font-size:13px}
a{color:#2f5bd3;text-decoration:none}@media(prefers-color-scheme:dark){body{background:#111317;color:#e4e7eb}a{color:#7c9cf5}}</style>
<h3>${esc(rel)}/</h3><p><a href="${base}..">../</a></p><table>${rows}</table>`;
}

function serveFile(res, file, wantsHtml = false) {
  if (!fs.existsSync(file)) {
    return send(res, 404, { error: 'not found' });
  }
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const entries = fs.readdirSync(file, { withFileTypes: true })
      .map((e) => ({ name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? null : fs.statSync(path.join(file, e.name)).size }));
    return wantsHtml
      ? send(res, 200, directoryPage(rel, entries), 'text/html; charset=utf-8')
      : send(res, 200, { directory: rel, entries });
  }
  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext] || (TEXT_EXT.has(ext) || stat.size < 2_000_000 ? 'text/plain; charset=utf-8' : 'application/octet-stream');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function startJob({ versions, cases, tags, skipTags, label, plugins }) {
  const script = plugins ? path.join(ROOT, 'tools', 'build-test-plugins.mjs') : path.join(ROOT, 'runner', 'run.mjs');
  const args = [script];
  if (!plugins) {
    if (versions) args.push(`--versions=${versions}`);
    if (cases) args.push(`--cases=${cases}`);
    if (tags) args.push(`--tags=${tags}`);
    if (skipTags) args.push(`--skip-tags=${skipTags}`);
    if (label) args.push(`--label=${label}`);
  }
  const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, windowsHide: true });
  job = { pid: child.pid, args: args.slice(1), kind: plugins ? 'plugins' : 'run', startedAt: new Date().toISOString(), running: true, log: '', exitCode: null };
  const append = (d) => {
    job.log += d.toString();
    if (job.log.length > 400_000) {
      job.log = job.log.slice(-300_000);
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', (code) => {
    job.running = false;
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/' || p === '/index.html') {
      return serveFile(res, path.join(UI_DIR, 'index.html'));
    }
    if (p.startsWith('/ui/')) {
      const file = path.join(UI_DIR, p.slice(4));
      return within(UI_DIR, file) ? serveFile(res, file) : send(res, 403, { error: 'forbidden' });
    }
    if (p === '/api/config') {
      const pluginsManifest = readJson(path.join(PLUGINS_OUT_DIR, 'manifest.json'));
      return send(res, 200, { config: redact(config), versions: list(config.SCAN_VERSIONS), plugins: pluginsManifest });
    }
    if (p === '/api/cases') {
      return send(res, 200, loadCases().map(({ dir, ...c }) => ({ ...c, path: path.relative(ROOT, dir).split(path.sep).join('/') })));
    }
    if (p === '/api/runs') {
      return send(res, 200, listRuns());
    }
    const caseMatch = p.match(/^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (caseMatch) {
      const dir = path.join(RESULTS_DIR, ...caseMatch.slice(1));
      if (!within(RESULTS_DIR, dir)) {
        return send(res, 403, { error: 'forbidden' });
      }
      const record = readJson(path.join(dir, 'case.json'));
      if (!record) {
        return send(res, 404, { error: 'case not run for this version' });
      }
      for (const s of record.steps || []) {
        const out = path.join(ROOT, s.outputDir || '');
        for (const name of ['combined', 'stdout', 'stderr']) {
          const file = path.join(out, `${name}.txt`);
          s[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        }
      }
      return send(res, 200, record);
    }
    const runMatch = p.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch) {
      const run = readJson(path.join(RESULTS_DIR, runMatch[1], 'run.json'));
      return run ? send(res, 200, run) : send(res, 404, { error: 'no such run' });
    }
    if (p === '/api/job' && req.method === 'GET') {
      return send(res, 200, job || { running: false });
    }
    if (p === '/api/job' && req.method === 'POST') {
      if (job?.running) {
        return send(res, 409, { error: 'a job is already running' });
      }
      startJob(await readBody(req));
      return send(res, 202, job);
    }
    if (p.startsWith('/files/')) {
      const file = path.join(ROOT, p.slice('/files/'.length));
      if (!within(RESULTS_DIR, file) && !within(CASES_DIR, file)) {
        return send(res, 403, { error: 'only results/ and cases/ are served' });
      }
      return serveFile(res, file, (req.headers.accept || '').includes('text/html'));
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`bal scan playground UI: http://localhost:${PORT}`);
});
