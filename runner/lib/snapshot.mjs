import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HASH_LIMIT = 8 * 1024 * 1024;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function snapshot(dir) {
  const files = new Map();
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        let hash = null;
        if (stat.size <= HASH_LIMIT) {
          hash = crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex');
        }
        files.set(toPosix(path.relative(dir, full)), { size: stat.size, mtimeMs: stat.mtimeMs, hash });
      }
    }
  };
  walk(dir);
  return files;
}

export function diffSnapshots(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];
  for (const [file, info] of after) {
    const prev = before.get(file);
    if (!prev) {
      created.push({ path: file, size: info.size });
    } else if (prev.hash !== info.hash || (info.hash === null && prev.mtimeMs !== info.mtimeMs)) {
      modified.push({ path: file, size: info.size, previousSize: prev.size });
    }
  }
  for (const [file, info] of before) {
    if (!after.has(file)) {
      deleted.push({ path: file, size: info.size });
    }
  }
  const byPath = (a, b) => a.path.localeCompare(b.path);
  return { created: created.sort(byPath), modified: modified.sort(byPath), deleted: deleted.sort(byPath) };
}

export function copyDir(src, dest, skip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(entry.name)) {
      continue;
    }
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to, skip);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}
