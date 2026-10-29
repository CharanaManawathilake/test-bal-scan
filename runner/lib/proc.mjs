import { spawn } from 'node:child_process';

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

/**
 * Runs a shell command and keeps stdout, stderr and their interleaving in arrival order.
 */
export function runCommand(command, { cwd, env, timeoutMs = 600000, secrets = [], echo = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true });
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
