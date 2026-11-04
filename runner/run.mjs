#!/usr/bin/env node
// Runs every playground case against each scan tool version in SCAN_VERSIONS and records what happened.
// Usage: node runner/run.mjs [--versions=a,b@local] [--cases=packages/*,sf-01*] [--tags=x] [--skip-tags=y]
//                            [--label=name] [--no-restore] [--env=path/to/.env] [--jobs=N]
//                            [--serial-tags=network,sonarqube] [--central=central|dev|stage]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCases, filterCases } from './lib/cases.mjs';
import {
  ROOT, RESULTS_DIR, PLUGINS_OUT_DIR, loadConfig, list, bool, redact, secretValues, interpolate,
} from './lib/env.mjs';
import { runCommand, stripAnsi, mask } from './lib/proc.mjs';
import { snapshot, diffSnapshots, copyDir } from './lib/snapshot.mjs';
import { observeStep } from './lib/observe.mjs';
import {
  CENTRALS, parseVersionSpec, switchScanVersion, activeScanVersion, activeToolFingerprint, withCentral,
} from './lib/tool.mjs';

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
// The UI polls these files while a run is in progress, so write via rename to never expose a half-written file.
function writeJson(file, data) {
  const text = JSON.stringify(data, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, text);
    fs.rmSync(tmp, { force: true });
  }
}

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

async function runCase(testCase, ctx, out) {
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
    central: ctx.central,
    startedAt: new Date().toISOString(),
    status: 'running',
    steps: [],
  };
  const saveRecord = () => writeJson(path.join(caseOut, 'case.json'), record);
  const terminal = [
    `${'='.repeat(100)}`,
    `CASE ${testCase.id} :: ${testCase.title}`,
    `scan tool ${ctx.version.spec}${ctx.central ? ` | Ballerina Central: ${ctx.central}` : ''}`,
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
  record.stepCount = allSteps.length;
  saveRecord();

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
    out(`  [${i + 1}/${allSteps.length}] ${step.setup ? '(setup) ' : ''}${command} ... `);
    const stepDir = path.join(caseOut, 'steps', `${String(i + 1).padStart(2, '0')}-${slug(step.name || command)}`);
    fs.mkdirSync(stepDir, { recursive: true });
    const liveFile = path.join(stepDir, 'live.txt');
    record.currentStep = {
      index: i + 1,
      name: step.name || command,
      setup: Boolean(step.setup),
      command: mask(command, ctx.secrets),
      startedAt: new Date().toISOString(),
      liveOutput: posix(path.relative(ROOT, liveFile)),
    };
    saveRecord();
    const result = await runCommand(command, {
      cwd, env, timeoutMs: ctx.timeoutMs, secrets: ctx.secrets,
      onData: (text) => fs.appendFileSync(liveFile, text),
    });
    fs.rmSync(liveFile, { force: true });
    const changes = diffSnapshots(before, snapshot(workDir));
    fs.writeFileSync(path.join(stepDir, 'stdout.txt'), stripAnsi(result.stdout));
    fs.writeFileSync(path.join(stepDir, 'stderr.txt'), stripAnsi(result.stderr));
    fs.writeFileSync(path.join(stepDir, 'combined.txt'), stripAnsi(result.combined));
    const observations = observeStep(result, changes, workDir);
    out(`exit ${result.exitCode}${result.timedOut ? ' (timeout)' : ''} in ${(result.durationMs / 1000).toFixed(1)}s\n`);

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
    record.currentStep = null;
    saveRecord();
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
  record.status = 'ran';
  delete record.currentStep;
  record.finishedAt = new Date().toISOString();
  terminal.push('');
  fs.writeFileSync(path.join(caseOut, 'terminal.txt'), terminal.filter((l) => l !== '').join('\n') + '\n');
  saveRecord();
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
    // Printed errors are tracked separately from exit codes, since some failures still exit 0.
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

  const central = String(args.central ?? config.CENTRAL ?? '').trim().toLowerCase();
  if (central && !CENTRALS.includes(central)) {
    console.error(`Unknown Central "${central}". Use one of: ${CENTRALS.join(', ')}.`);
    process.exit(2);
  }

  const jobs = Math.max(1, Number.parseInt(args.jobs || config.JOBS || '1', 10) || 1);
  // Cases with these tags share global state (Ballerina Central cache, the SonarQube server), so they never overlap.
  const serialTags = list(args['serial-tags'] ?? (config.SERIAL_TAGS || 'network,sonarqube'));
  const isSerial = (c) => c.tags.some((t) => serialTags.includes(t));
  const serialCount = cases.filter(isSerial).length;

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

  const now = new Date();
  // Local time, not UTC, so run IDs match the user's wall clock.
  const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = args.label ? `${stamp}_${slug(args.label)}` : stamp;
  const runDir = path.join(RESULTS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const originalActive = readActiveToolEntry();

  const runEnv = withCentral(env, central);
  const balVersion = await runCommand(`${bal} version`, { env: runEnv });
  const run = {
    id: runId,
    label: args.label || '',
    startedAt: new Date().toISOString(),
    status: 'running',
    host: { platform: process.platform, node: process.version, hostname: os.hostname() },
    balVersion: stripAnsi(balVersion.combined).trim(),
    originalActiveScanVersion: originalActive,
    central: central || null,
    config: redact(config),
    versions: versions.map((v) => ({ ...v, status: 'pending', cases: [], running: [] })),
    caseCount: cases.length,
    caseIds: cases.map((c) => c.id),
    pid: process.pid,
  };
  const saveRun = () => writeJson(path.join(runDir, 'run.json'), run);
  saveRun();
  console.log(`Run ${runId}: ${cases.length} case(s) x ${versions.length} version(s), ${jobs} parallel job(s), ${serialCount} serial case(s)${central ? `, Central: ${central}` : ''}\nResults: ${runDir}\n`);

  const terminalLog = [`bal scan playground run ${runId}`, run.balVersion, ''];
  for (const versionEntry of run.versions) {
    const version = parseVersionSpec(versionEntry.spec);
    const versionDir = path.join(runDir, slug(version.spec));
    fs.mkdirSync(versionDir, { recursive: true });
    versionEntry.dir = slug(version.spec);
    // A @dev/@stage/@central suffix on the version wins over the run-wide Central for its tool pull and cases.
    const versionCentral = version.central || central || null;
    const versionEnv = withCentral(runEnv, version.central);
    versionEntry.central = versionCentral;
    console.log(`>>> switching scan tool to ${version.spec}${versionCentral ? ` (Central: ${versionCentral})` : ''}`);
    const switched = await switchScanVersion(bal, version, runEnv);
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
    terminalLog.push(`${'#'.repeat(100)}`, `##### scan tool ${version.spec}${versionCentral ? ` (Central: ${versionCentral})` : ''}`, `${'#'.repeat(100)}`);

    const ctx = {
      config, env: versionEnv, central: versionCentral, bal, version, versionDir, runDir,
      timeoutMs: Number(config.STEP_TIMEOUT_SECONDS || 600) * 1000,
      secrets: secretValues(config),
    };
    const width = String(cases.length).length;
    const summaries = new Array(cases.length);
    let completed = 0;
    const serialQueue = cases.map((_, i) => i).filter((i) => isSerial(cases[i]));
    const parallelQueue = cases.map((_, i) => i).filter((i) => !isSerial(cases[i]));
    const runOne = async (i) => {
      const testCase = cases[i];
      const label = `[${version.spec}] ${testCase.id}${isSerial(testCase) ? ' (serial)' : ''}`;
      // With jobs > 1, each case's output is buffered and printed as one block when it finishes.
      let buffer = '';
      const out = jobs > 1 ? (s) => { buffer += s; } : (s) => process.stdout.write(s);
      if (jobs === 1) {
        out(`(${String(completed + 1).padStart(width)}/${cases.length}) ${label}\n`);
      }
      versionEntry.running.push(testCase.id);
      saveRun();
      let record;
      try {
        record = await runCase(testCase, ctx, out);
      } catch (err) {
        record = { id: testCase.id, title: testCase.title, category: testCase.category, tags: testCase.tags,
          status: 'runner-error', skipReason: String(err?.stack || err), steps: [] };
        out(`    runner error: ${err?.message}\n`);
      }
      if (record.status === 'skipped') {
        out(`    skipped: ${record.skipReason}\n`);
      }
      completed++;
      if (jobs > 1) {
        process.stdout.write(`(${String(completed).padStart(width)}/${cases.length}) ${label}\n${buffer}`);
      }
      summaries[i] = caseSummary(record);
      versionEntry.cases = summaries.filter(Boolean);
      versionEntry.running = versionEntry.running.filter((id) => id !== testCase.id);
      saveRun();
    };
    // Serial cases get one lane that starts right away; once it drains, it joins the parallel lanes.
    const drain = async (queue) => {
      while (queue.length) {
        await runOne(queue.shift());
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, cases.length) }, async (_, lane) => {
      if (lane === 0) {
        await drain(serialQueue);
      }
      await drain(parallelQueue);
    }));
    for (const testCase of cases) {
      const caseTerminal = path.join(versionDir, testCase.category, testCase.name, 'terminal.txt');
      if (fs.existsSync(caseTerminal)) {
        terminalLog.push(fs.readFileSync(caseTerminal, 'utf8'));
      }
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
