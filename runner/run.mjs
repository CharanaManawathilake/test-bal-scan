#!/usr/bin/env node
// Runs every playground case against each scan tool version in SCAN_VERSIONS and records what happened.
// Usage: node runner/run.mjs [--versions=a,b@local] [--cases=packages/*,sf-01*] [--tags=x] [--skip-tags=y]
//                            [--label=name] [--no-restore] [--env=path/to/.env]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCases, filterCases } from './lib/cases.mjs';
import {
  ROOT, RESULTS_DIR, PLUGINS_OUT_DIR, loadConfig, list, bool, redact, secretValues, interpolate,
} from './lib/env.mjs';
import { runCommand, stripAnsi } from './lib/proc.mjs';
import { snapshot, diffSnapshots, copyDir } from './lib/snapshot.mjs';
import { observeStep } from './lib/observe.mjs';
import { parseVersionSpec, switchScanVersion, activeScanVersion, activeToolFingerprint } from './lib/tool.mjs';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) {
      args[m[1]] = m[2] ?? true;
    }
  }
  return args;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const posix = (p) => p.split(path.sep).join('/');
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

function readActiveToolEntry() {
  const file = path.join(os.homedir(), '.ballerina', '.config', 'bal-tools.toml');
  if (!fs.existsSync(file)) {
    return null;
  }
  const blocks = fs.readFileSync(file, 'utf8').split('[[tool]]').slice(1);
  for (const block of blocks) {
    const field = (k) => block.match(new RegExp(`^${k}\\s*=\\s*"?([^"\\r\\n]*)"?`, 'm'))?.[1];
    if (field('id') === 'scan' && field('active') === 'true') {
      const repo = field('repository');
      return `${field('version')}${repo === 'local' ? '@local' : ''}`;
    }
  }
  return null;
}

function renderTemplates(dir, vars) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      renderTemplates(full, vars);
    } else if (entry.name.endsWith('.tmpl')) {
      fs.writeFileSync(full.slice(0, -'.tmpl'.length), interpolate(fs.readFileSync(full, 'utf8'), vars));
      fs.rmSync(full);
    }
  }
}

function missingRequirements(testCase, config) {
  const missing = [];
  for (const key of testCase.requires.env || []) {
    if (!config[key]) {
      missing.push(`env ${key} is not set (see .env)`);
    }
  }
  if (testCase.requires.plugins && !fs.existsSync(path.join(PLUGINS_OUT_DIR, 'manifest.json'))) {
    missing.push('test plugins are not built (run: npm run setup:plugins)');
  }
  return missing;
}

const NOISE = /(^|\/)target\/(cache|bin|build|backup|resources)(\/|$)/;

function formatChanges(changes) {
  const lines = [];
  for (const [label, items] of [['+', changes.created], ['~', changes.modified], ['-', changes.deleted]]) {
    const shown = items.filter((f) => !/^target\/(cache|bin|build|resources)\//.test(f.path));
    const hidden = items.length - shown.length;
    for (const f of shown) {
      lines.push(`  ${label} ${f.path} (${f.size} B)`);
    }
    if (hidden > 0) {
      lines.push(`  ${label} ... ${hidden} more under target/{cache,bin,build,backup,resources}`);
    }
  }
  return lines.length ? lines.join('\n') : '  (no file changes)';
}

async function runCase(testCase, ctx) {
  const caseOut = path.join(ctx.versionDir, testCase.category, testCase.name);
  const workDir = path.join(caseOut, 'work');
  fs.rmSync(caseOut, { recursive: true, force: true });
  fs.mkdirSync(caseOut, { recursive: true });

  const record = {
    id: testCase.id,
    category: testCase.category,
    name: testCase.name,
    title: testCase.title,
    description: testCase.description,
    tags: testCase.tags,
    upstream: testCase.upstream,
    notes: testCase.notes,
    version: ctx.version.spec,
    startedAt: new Date().toISOString(),
    status: 'ran',
    steps: [],
  };
  const terminal = [
    `${'='.repeat(100)}`,
    `CASE ${testCase.id} :: ${testCase.title}`,
    `scan tool ${ctx.version.spec}`,
    testCase.description ? `\n${testCase.description}` : '',
    `${'='.repeat(100)}`,
  ];

  const missing = missingRequirements(testCase, ctx.config);
  if (missing.length) {
    record.status = 'skipped';
    record.skipReason = missing.join('; ');
    terminal.push(`SKIPPED: ${record.skipReason}`, '');
    fs.writeFileSync(path.join(caseOut, 'terminal.txt'), terminal.join('\n'));
    writeJson(path.join(caseOut, 'case.json'), record);
    return record;
  }

  copyDir(testCase.dir, workDir, (name) => name === 'case.json');
  const vars = {
    ...ctx.config,
    WORK_DIR: posix(workDir),
    WORK_DIR_NATIVE: workDir,
    CASE_ID: testCase.id,
    SCAN_VERSION: ctx.version.version,
    PLUGINS_OUT_DIR: posix(PLUGINS_OUT_DIR),
    RECORDER_PLUGIN_JAR: posix(path.join(PLUGINS_OUT_DIR, 'recorder-platform-plugin.jar')),
    SONAR_PROJECT_KEY: slug(`${ctx.config.SONAR_PROJECT_KEY_PREFIX || 'bal-scan-playground'}-${testCase.name}-${ctx.version.version}`),
    SONAR_PLATFORM_PLUGIN_PATH: posix(ctx.config.SONAR_PLATFORM_PLUGIN_PATH || ''),
  };
  renderTemplates(workDir, vars);
  record.workDir = posix(path.relative(ROOT, workDir));

  const allSteps = [...testCase.setup, ...testCase.steps];
  for (let i = 0; i < allSteps.length; i++) {
    const step = allSteps[i];
    const command = interpolate(step.run, vars).replace(/^bal(?=\s|$)/, ctx.bal);
    const cwd = path.join(workDir, interpolate(step.cwd || '.', vars));
    fs.mkdirSync(cwd, { recursive: true });
    const env = { ...ctx.env };
    for (const [k, v] of Object.entries(step.env || {})) {
      env[k] = interpolate(String(v), vars);
    }
    const before = snapshot(workDir);
    process.stdout.write(`  [${i + 1}/${allSteps.length}] ${step.setup ? '(setup) ' : ''}${command} ... `);
    const result = await runCommand(command, { cwd, env, timeoutMs: ctx.timeoutMs, secrets: ctx.secrets });
    const changes = diffSnapshots(before, snapshot(workDir));
    const stepDir = path.join(caseOut, 'steps', `${String(i + 1).padStart(2, '0')}-${slug(step.name || command)}`);
    fs.mkdirSync(stepDir, { recursive: true });
    fs.writeFileSync(path.join(stepDir, 'stdout.txt'), stripAnsi(result.stdout));
    fs.writeFileSync(path.join(stepDir, 'stderr.txt'), stripAnsi(result.stderr));
    fs.writeFileSync(path.join(stepDir, 'combined.txt'), stripAnsi(result.combined));
    const observations = observeStep(result, changes, workDir);
    console.log(`exit ${result.exitCode}${result.timedOut ? ' (timeout)' : ''} in ${(result.durationMs / 1000).toFixed(1)}s`);

    record.steps.push({
      index: i + 1,
      name: step.name || command,
      setup: Boolean(step.setup),
      note: step.note || '',
      command: result.command,
      cwd: posix(path.relative(workDir, cwd)) || '.',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      outputDir: posix(path.relative(ROOT, stepDir)),
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
      changes,
      observations,
    });
    const shownCwd = posix(path.relative(ctx.runDir, cwd));
    terminal.push(
      '',
      `--- step ${i + 1}${step.setup ? ' [setup]' : ''}: ${step.name || command}`,
      step.note ? `    note: ${step.note}` : '',
      `${shownCwd}> ${result.command}`,
      stripAnsi(result.combined).replace(/\s+$/, ''),
      `[exit ${result.exitCode}${result.timedOut ? ', timed out' : ''} | ${(result.durationMs / 1000).toFixed(1)}s | stdout ${result.stdout.length} B, stderr ${result.stderr.length} B]`,
      'files:',
      formatChanges(changes),
    );
  }
  record.finishedAt = new Date().toISOString();
  terminal.push('');
  fs.writeFileSync(path.join(caseOut, 'terminal.txt'), terminal.filter((l) => l !== '').join('\n') + '\n');
  writeJson(path.join(caseOut, 'case.json'), record);
  return record;
}

function caseSummary(record) {
  const scanSteps = record.steps.filter((s) => !s.setup);
  return {
    id: record.id,
    title: record.title,
    category: record.category,
    tags: record.tags,
    status: record.status,
    skipReason: record.skipReason,
    exitCodes: scanSteps.map((s) => s.exitCode),
    setupExitCodes: record.steps.filter((s) => s.setup).map((s) => s.exitCode),
    // bal.bat on Windows exits 0 even on failure, so printed errors are tracked separately.
    errorFlags: scanSteps.map((s) => (s.observations?.errors?.length || 0) > 0),
    setupErrors: record.steps.filter((s) => s.setup && s.observations?.errors?.length).length,
    issueTotals: scanSteps.map((s) => s.observations?.stdoutIssues?.total ?? null),
    durationMs: record.steps.reduce((n, s) => n + s.durationMs, 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.env ? path.resolve(args.env) : undefined);
  const bal = config.BAL_CMD || 'bal';
  const versions = list(args.versions || config.SCAN_VERSIONS).map(parseVersionSpec);
  if (!versions.length) {
    console.error('No scan tool versions given. Set SCAN_VERSIONS in .env or pass --versions=...');
    process.exit(2);
  }
  const cases = filterCases(loadCases(), {
    patterns: list(args.cases || config.CASES),
    tags: list(args.tags || config.TAGS),
    skipTags: list(args['skip-tags'] || config.SKIP_TAGS),
  });

  const env = { ...process.env };
  for (const [k, v] of Object.entries(config)) {
    if (v !== '') {
      env[k] = v;
    }
  }
  if (config.SONAR_SCANNER_HOME) {
    env.PATH = `${path.join(config.SONAR_SCANNER_HOME, 'bin')}${path.delimiter}${env.PATH || env.Path || ''}`;
    env.Path = env.PATH;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = args.label ? `${stamp}_${slug(args.label)}` : stamp;
  const runDir = path.join(RESULTS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const originalActive = readActiveToolEntry();

  const balVersion = await runCommand(`${bal} version`, { env });
  const run = {
    id: runId,
    label: args.label || '',
    startedAt: new Date().toISOString(),
    status: 'running',
    host: { platform: process.platform, node: process.version, hostname: os.hostname() },
    balVersion: stripAnsi(balVersion.combined).trim(),
    originalActiveScanVersion: originalActive,
    config: redact(config),
    versions: versions.map((v) => ({ ...v, status: 'pending', cases: [] })),
    caseCount: cases.length,
  };
  const saveRun = () => writeJson(path.join(runDir, 'run.json'), run);
  saveRun();
  console.log(`Run ${runId}: ${cases.length} case(s) x ${versions.length} version(s)\nResults: ${runDir}\n`);

  const terminalLog = [`bal scan playground run ${runId}`, run.balVersion, ''];
  for (const versionEntry of run.versions) {
    const version = parseVersionSpec(versionEntry.spec);
    const versionDir = path.join(runDir, slug(version.spec));
    fs.mkdirSync(versionDir, { recursive: true });
    versionEntry.dir = slug(version.spec);
    console.log(`>>> switching scan tool to ${version.spec}`);
    const switched = await switchScanVersion(bal, version, env);
    fs.writeFileSync(path.join(versionDir, 'tool-switch.txt'), switched.log
      .map((r) => `> ${r.command}\n${stripAnsi(r.combined).trim()}\n[exit ${r.exitCode}]`).join('\n\n'));
    versionEntry.activeAfterSwitch = switched.active;
    if (!switched.ok) {
      versionEntry.status = 'unavailable';
      console.log(`    could not activate ${version.spec} (active: ${switched.active}); skipping its cases\n`);
      terminalLog.push(`##### scan ${version.spec}: could not activate, see ${posix(path.relative(runDir, versionDir))}/tool-switch.txt`, '');
      saveRun();
      continue;
    }
    versionEntry.status = 'running';
    versionEntry.toolBefore = activeToolFingerprint();
    saveRun();
    terminalLog.push(`${'#'.repeat(100)}`, `##### scan tool ${version.spec}`, `${'#'.repeat(100)}`);

    const ctx = {
      config, env, bal, version, versionDir, runDir,
      timeoutMs: Number(config.STEP_TIMEOUT_SECONDS || 600) * 1000,
      secrets: secretValues(config),
    };
    for (const testCase of cases) {
      console.log(`[${version.spec}] ${testCase.id}`);
      let record;
      try {
        record = await runCase(testCase, ctx);
      } catch (err) {
        record = { id: testCase.id, title: testCase.title, category: testCase.category, tags: testCase.tags,
          status: 'runner-error', skipReason: String(err?.stack || err), steps: [] };
        console.log(`    runner error: ${err?.message}`);
      }
      if (record.status === 'skipped') {
        console.log(`    skipped: ${record.skipReason}`);
      }
      versionEntry.cases.push(caseSummary(record));
      const caseTerminal = path.join(versionDir, testCase.category, testCase.name, 'terminal.txt');
      if (fs.existsSync(caseTerminal)) {
        terminalLog.push(fs.readFileSync(caseTerminal, 'utf8'));
      }
      saveRun();
    }
    versionEntry.status = 'done';
    versionEntry.toolAfter = activeToolFingerprint();
    if (versionEntry.toolBefore?.md5 !== versionEntry.toolAfter?.md5 || versionEntry.toolBefore?.version !== versionEntry.toolAfter?.version) {
      versionEntry.toolChangedDuringRun = true;
      console.log(`    WARNING: the active scan tool changed while ${version.spec} was running; later cases used the new build`);
      terminalLog.push(`##### WARNING: the active scan tool changed during this version (before ${JSON.stringify(versionEntry.toolBefore)}, after ${JSON.stringify(versionEntry.toolAfter)})`);
    }
    saveRun();
  }

  if (originalActive && bool(config.RESTORE_ACTIVE_VERSION, true) && !args['no-restore']) {
    const restored = await switchScanVersion(bal, parseVersionSpec(originalActive), env);
    run.restoredActiveScanVersion = restored.active;
    console.log(`\nRestored active scan tool: ${restored.active}`);
  } else {
    run.restoredActiveScanVersion = (await activeScanVersion(bal, env)).version;
  }
  run.status = 'done';
  run.finishedAt = new Date().toISOString();
  saveRun();
  fs.writeFileSync(path.join(runDir, 'terminal.txt'), terminalLog.join('\n'));
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest.txt'), runId);
  console.log(`\nDone. Full terminal log: ${path.join(runDir, 'terminal.txt')}`);
  console.log('View results: npm run ui  (then open http://localhost:' + (config.UI_PORT || 4173) + ')');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
