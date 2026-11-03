import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text) {
  return text.replace(ANSI, '');
}

export function mask(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join('***');
  }
  return out;
}

function isBatchCommand(command, cwd, env) {
  const program = command.trim().match(/^"([^"]+)"|^(\S+)/);
  if (!program) {
    return false;
  }
  const name = program[1] || program[2];
  if (/\.(bat|cmd)$/i.test(name)) {
    return true;
  }
  if (path.extname(name)) {
    return false;
  }
  const exts = (env?.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = /[\\/]/.test(name)
    ? ['']
    : [cwd || process.cwd(), ...(env?.PATH || env?.Path || process.env.PATH || '').split(path.delimiter)];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (fs.existsSync(path.resolve(cwd || '.', dir, name + ext))) {
        return /^\.(bat|cmd)$/i.test(ext);
      }
    }
  }
  return false;
}

/**
 * Runs a shell command and keeps stdout, stderr and their interleaving in arrival order.
 */
export function runCommand(command, { cwd, env, timeoutMs = 600000, secrets = [], echo = false, onData } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // cmd /c reports exit code 0 for a .bat that ends in a bare `exit /b` (e.g. bal.bat); `call` keeps the real code.
    const shellCommand = process.platform === 'win32' && isBatchCommand(command, cwd, env) ? `call ${command}` : command;
    const child = spawn(shellCommand, { cwd, env, shell: true, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const collect = (stream) => (data) => {
      const text = mask(data.toString('utf8'), secrets);
      chunks.push({ stream, t: Date.now() - started, text });
      if (stream === 'stdout') {
        stdout += text;
      } else {
        stderr += text;
      }
      if (echo) {
        process.stdout.write(text);
      }
      onData?.(text, stream);
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (err) => {
      stderr += `\n[runner] failed to start: ${err.message}\n`;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        command: mask(command, secrets),
        cwd,
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        combined: chunks.map((c) => c.text).join(''),
        chunks,
      });
    });
  });
}
