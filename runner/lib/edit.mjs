import fs from 'node:fs';
import path from 'node:path';

// Edit steps change the fixture between scans (e.g. to check that a fingerprint survives an unrelated edit).
// They run in-process, so they behave the same on every OS, and record a before/after copy of each text file.

const SOURCE_FILE = /\.(bal|toml|json|md)$/i;
const MAX_TEXT_BYTES = 200 * 1024;
const SKIP_DIRS = new Set(['target', '.git']);

const posix = (p) => p.split(path.sep).join('/');

function walk(dir, visit) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(full, visit);
      }
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}

function copyInto(src, dest) {
  if (fs.statSync(src).isDirectory()) {
    walk(src, (file) => {
      const to = path.join(dest, path.relative(src, file));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(file, to);
    });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function readText(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size <= MAX_TEXT_BYTES ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

function textFiles(root) {
  const files = new Map();
  walk(root, (file) => {
    if (SOURCE_FILE.test(file)) {
      files.set(posix(path.relative(root, file)), readText(file));
    }
  });
  return files;
}

const OPERATIONS = {
  // use <variant> [base]: replace every .bal file with base + variant (base defaults to <variant>/../base)
  use(cwd, [variant, base]) {
    const variantDir = path.resolve(cwd, variant);
    const baseDir = path.resolve(cwd, base || path.join(variant, '..', 'base'));
    walk(cwd, (file) => {
      if (file.endsWith('.bal')) {
        fs.rmSync(file);
      }
    });
    if (fs.existsSync(baseDir) && baseDir !== variantDir) {
      copyInto(baseDir, cwd);
    }
    copyInto(variantDir, cwd);
    return `sources replaced with ${variant}${fs.existsSync(baseDir) && baseDir !== variantDir ? ` over ${posix(path.relative(cwd, baseDir))}` : ''}`;
  },
  copy(cwd, [from, to]) {
    copyInto(path.resolve(cwd, from), path.resolve(cwd, to));
    return `copied ${from} -> ${to}`;
  },
  move(cwd, [from, to]) {
    fs.mkdirSync(path.dirname(path.resolve(cwd, to)), { recursive: true });
    fs.renameSync(path.resolve(cwd, from), path.resolve(cwd, to));
    return `moved ${from} -> ${to}`;
  },
  delete(cwd, paths) {
    paths.forEach((p) => fs.rmSync(path.resolve(cwd, p), { recursive: true, force: true }));
    return `deleted ${paths.join(', ')}`;
  },
  mkdir(cwd, paths) {
    paths.forEach((p) => fs.mkdirSync(path.resolve(cwd, p), { recursive: true }));
    return `created ${paths.join(', ')}`;
  },
  crlf(cwd, files) {
    files.forEach((f) => {
      const file = path.resolve(cwd, f);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    });
    return `CRLF line endings in ${files.join(', ')}`;
  },
  lf(cwd, files) {
    files.forEach((f) => {
      const file = path.resolve(cwd, f);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    });
    return `LF line endings in ${files.join(', ')}`;
  },
  bom(cwd, files) {
    files.forEach((f) => {
      const file = path.resolve(cwd, f);
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, text.startsWith('﻿') ? text : `﻿${text}`);
    });
    return `byte order mark added to ${files.join(', ')}`;
  },
  // write <file> <text>: \n in the text is a newline
  write(cwd, [file, text = '']) {
    fs.mkdirSync(path.dirname(path.resolve(cwd, file)), { recursive: true });
    fs.writeFileSync(path.resolve(cwd, file), text.replace(/\\n/g, '\n'));
    return `wrote ${file}`;
  },
};

export function editCommand(args) {
  return `edit ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
}

/**
 * Applies one edit operation in cwd. Returns a runCommand-shaped result plus the text files it changed, with their
 * contents before and after, relative to workDir.
 */
export function runEdit(args, { cwd, workDir }) {
  const started = Date.now();
  const [op, ...rest] = args;
  const before = textFiles(workDir);
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    if (!OPERATIONS[op]) {
      throw new Error(`unknown edit operation '${op}'; expected one of ${Object.keys(OPERATIONS).join(', ')}`);
    }
    stdout = `${OPERATIONS[op](cwd, rest)}\n`;
  } catch (err) {
    stderr = `edit failed: ${err.message}\n`;
    exitCode = 1;
  }
  const after = textFiles(workDir);
  const fileDiffs = [];
  for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.has(file) ? before.get(file) : null;
    const b = after.has(file) ? after.get(file) : null;
    if (a !== b) {
      fileDiffs.push({ path: file, before: a, after: b });
    }
  }
  return {
    command: editCommand(args),
    cwd,
    exitCode,
    signal: null,
    timedOut: false,
    durationMs: Date.now() - started,
    stdout,
    stderr,
    combined: stdout + stderr,
    fileDiffs,
  };
}
