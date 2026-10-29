import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './proc.mjs';

const REPO_ENV = {
  dev: { BALLERINA_DEV_CENTRAL: 'true' },
  stage: { BALLERINA_STAGE_CENTRAL: 'true' },
};

export function parseVersionSpec(spec) {
  const [version, repo = 'central'] = spec.split('@').map((s) => s.trim());
  return { spec, version, repo: repo.toLowerCase() };
}

export async function activeScanVersion(bal, env) {
  const result = await runCommand(`${bal} tool list`, { env });
  const row = result.stdout.split(/\r?\n/).find((l) => /^\|\s*scan\s*\|/.test(l));
  // A local-repository tool shows as "0.13.0-SNAPSHOT [repo = local]", truncated to the column width.
  return { version: row ? row.split('|')[2].trim().split(/\s+/)[0] : null, result };
}

/**
 * Identifies the active scan tool build, so a tool republished in the middle of a run can be noticed.
 */
export function activeToolFingerprint() {
  const file = path.join(os.homedir(), '.ballerina', '.config', 'bal-tools.toml');
  if (!fs.existsSync(file)) {
    return null;
  }
  const block = fs.readFileSync(file, 'utf8').split('[[tool]]')
    .find((b) => /id\s*=\s*"scan"/.test(b) && /active\s*=\s*true/.test(b));
  if (!block) {
    return null;
  }
  const version = block.match(/version\s*=\s*"([^"]+)"/)?.[1];
  const repo = /repository\s*=\s*"local"/.test(block) ? 'local' : 'central.ballerina.io';
  const toolDir = path.join(os.homedir(), '.ballerina', 'repositories', repo, 'bala', 'ballerina', 'tool_scan', version);
  for (const platform of fs.existsSync(toolDir) ? fs.readdirSync(toolDir) : []) {
    const libs = path.join(toolDir, platform, 'tool', 'libs');
    const jar = fs.existsSync(libs) && fs.readdirSync(libs).find((f) => /^scan-command-.*\.jar$/.test(f));
    if (jar) {
      const full = path.join(libs, jar);
      const md5 = crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex');
      return { version, repository: repo, jar: full, md5, modified: fs.statSync(full).mtime.toISOString() };
    }
  }
  return { version, repository: repo, jar: null };
}

/**
 * Makes the given scan tool version the active one: `bal tool use`, then `bal tool pull` and `use` again,
 * and confirms the switch through `bal tool list`.
 */
export async function switchScanVersion(bal, { version, repo }, baseEnv) {
  const env = { ...baseEnv, ...(REPO_ENV[repo] || {}) };
  const repoFlag = repo === 'local' ? ' --repository=local' : '';
  const log = [];
  // After a pull, bal keeps a higher installed version active until `use` is run again.
  for (const action of ['use', 'pull', 'use']) {
    const result = await runCommand(`${bal} tool ${action} scan:${version}${repoFlag}`, { env, timeoutMs: 900000 });
    log.push(result);
    const active = await activeScanVersion(bal, baseEnv);
    log.push(active.result);
    if (active.version === version) {
      return { ok: true, active: active.version, log };
    }
  }
  const active = await activeScanVersion(bal, baseEnv);
  return { ok: false, active: active.version, log };
}
