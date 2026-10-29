#!/usr/bin/env node
// Builds the plugins the analyzer / platform cases rely on, the way upstream's test-compiler-plugins and
// test-static-code-analysis-platform-plugins Gradle projects do, but with javac and bal only:
//   * analyzer packages (exampleOrg|ballerina|ballerinax)/example_module_static_code_analyzer and three invalid ones,
//     packed and pushed to the local repository, then copied into the central.ballerina.io cache like upstream does
//   * tools/test-plugins/out/recorder-platform-plugin.jar, a platform plugin for the "recorder" and "recorder2" platforms
// Usage: node tools/build-test-plugins.mjs [--clean]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, PLUGINS_OUT_DIR, loadConfig } from '../runner/lib/env.mjs';
import { runCommand, stripAnsi } from '../runner/lib/proc.mjs';

const SRC = path.join(ROOT, 'tools', 'test-plugins', 'src');
const BUILD = path.join(ROOT, 'tools', 'test-plugins', 'build');
const REPOS = path.join(os.homedir(), '.ballerina', 'repositories');

const VALID_RULES = [
  { id: 1, kind: 'CODE_SMELL', description: 'rule 1' },
  { id: 2, kind: 'BUG', description: 'rule 2' },
  { id: 3, kind: 'VULNERABILITY', description: 'rule 3' },
];

const ANALYZERS = [
  { org: 'exampleOrg', name: 'example_module_static_code_analyzer', rules: VALID_RULES },
  { org: 'ballerina', name: 'example_module_static_code_analyzer', rules: VALID_RULES },
  { org: 'ballerinax', name: 'example_module_static_code_analyzer', rules: VALID_RULES },
  {
    org: 'invalid', name: 'invalid_module_ruleformat_static_code_analyzer',
    rules: VALID_RULES.map(({ id, kind, description }) => ({ id, severity: kind, description })),
  },
  {
    org: 'invalid', name: 'invalid_module_rulekind_static_code_analyzer',
    rules: VALID_RULES.map((r) => (r.id === 3 ? { ...r, kind: 'SECURITY_HOTSPOT' } : r)),
  },
  { org: 'invalid', name: 'invalid_module_rules_static_code_analyzer', rules: VALID_RULES[0] },
];

const log = (msg) => console.log(`[plugins] ${msg}`);

async function sh(command, cwd, env) {
  log(`${path.relative(ROOT, cwd) || '.'}> ${command}`);
  const result = await runCommand(command, { cwd, env, timeoutMs: 900000 });
  const out = stripAnsi(result.combined).trim();
  if (out) {
    console.log(out.split('\n').map((l) => `    ${l}`).join('\n'));
  }
  if (result.exitCode !== 0) {
    throw new Error(`command failed (exit ${result.exitCode}): ${command}`);
  }
  return result;
}

function activeScanCommandJar() {
  const toolsToml = path.join(os.homedir(), '.ballerina', '.config', 'bal-tools.toml');
  const blocks = fs.existsSync(toolsToml) ? fs.readFileSync(toolsToml, 'utf8').split('[[tool]]') : [];
  const active = blocks.find((b) => /id\s*=\s*"scan"/.test(b) && /active\s*=\s*true/.test(b));
  if (!active) {
    return null;
  }
  const version = active.match(/version\s*=\s*"([^"]+)"/)[1];
  const repo = /repository\s*=\s*"local"/.test(active) ? 'local' : 'central.ballerina.io';
  const toolDir = path.join(REPOS, repo, 'bala', 'ballerina', 'tool_scan', version);
  for (const platform of fs.existsSync(toolDir) ? fs.readdirSync(toolDir) : []) {
    const libs = path.join(toolDir, platform, 'tool', 'libs');
    const jar = fs.existsSync(libs) && fs.readdirSync(libs).find((f) => /^scan-command-.*\.jar$/.test(f));
    if (jar) {
      return path.join(libs, jar);
    }
  }
  return null;
}

// The active distribution first, then the other installed ones, newest first: a distribution built for a newer
// Java than the local javac (2201.14+ targets Java 25) cannot be compiled against, but an older one can.
async function distributionCandidates(config, env) {
  if (config.BAL_DISTRIBUTION_HOME) {
    return [config.BAL_DISTRIBUTION_HOME];
  }
  const result = await runCommand(`${config.BAL_CMD || 'bal'} home`, { env });
  const active = fs.realpathSync.native(path.resolve(stripAnsi(result.stdout).trim()));
  const parent = path.dirname(active);
  const others = fs.readdirSync(parent)
    .filter((d) => /^ballerina-\d/.test(d))
    .map((d) => path.join(parent, d))
    .filter((d) => d !== active && fs.existsSync(path.join(d, 'bre', 'lib')))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return [active, ...others];
}

async function compilePlatformPlugin(scanJar, candidates, env, outDir) {
  const sources = fs.readdirSync(path.join(SRC, 'platform')).map((f) => `"${path.join(SRC, 'platform', f)}"`);
  for (const home of candidates) {
    const classpath = [scanJar, path.join(home, 'bre', 'lib', '*')].join(path.delimiter);
    const command = `javac --release 21 -proc:none -nowarn -cp "${classpath}" -d "${outDir}" ${sources.join(' ')}`;
    const result = await runCommand(command, { cwd: ROOT, env });
    if (result.exitCode === 0) {
      return { home, classpath };
    }
    log(`cannot compile against ${home}: ${stripAnsi(result.combined).split('\n').find((l) => /wrong version|error/.test(l))?.trim()}`);
  }
  throw new Error('javac failed against every installed distribution; set BAL_DISTRIBUTION_HOME in .env');
}

function clean() {
  for (const { org, name } of ANALYZERS) {
    for (const repo of ['local', 'central.ballerina.io']) {
      const dir = path.join(REPOS, repo, 'bala', org, name);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        log(`removed ${dir}`);
      }
    }
  }
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.rmSync(PLUGINS_OUT_DIR, { recursive: true, force: true });
  log('clean done');
}

async function main() {
  if (process.argv.includes('--clean')) {
    clean();
    return;
  }
  const config = loadConfig();
  const env = { ...process.env };
  const scanJar = config.SCAN_COMMAND_JAR || activeScanCommandJar();
  if (!scanJar || !fs.existsSync(scanJar)) {
    throw new Error('cannot find the scan-command JAR; set SCAN_COMMAND_JAR in .env');
  }
  log(`scan-command: ${scanJar}`);

  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(PLUGINS_OUT_DIR, { recursive: true });

  // Platform plugin
  const platformBuild = path.join(BUILD, 'platform');
  fs.mkdirSync(path.join(platformBuild, 'classes', 'META-INF', 'services'), { recursive: true });
  fs.writeFileSync(path.join(platformBuild, 'classes', 'META-INF', 'services', 'io.ballerina.scan.StaticCodeAnalysisPlatformPlugin'),
    'playground.platform.RecorderPlatformPlugin\nplayground.platform.SecondRecorderPlatformPlugin\n');
  const { home: balHome, classpath } = await compilePlatformPlugin(scanJar,
    await distributionCandidates(config, env), env, path.join(platformBuild, 'classes'));
  log(`compiled against ${balHome}`);
  const recorderJar = path.join(PLUGINS_OUT_DIR, 'recorder-platform-plugin.jar');
  await sh(`jar --create --file "${recorderJar}" -C "${path.join(platformBuild, 'classes')}" .`, ROOT, env);

  // Analyzer compiler plugins
  const template = fs.readFileSync(path.join(SRC, 'analyzer', 'StaticCodeAnalyzerPlugin.java'), 'utf8');
  const built = [];
  for (const analyzer of ANALYZERS) {
    const id = `${analyzer.org}_${analyzer.name}`;
    const javaPackage = `playground.analyzers.${id.toLowerCase()}`;
    const dir = path.join(BUILD, id);
    const javaDir = path.join(dir, 'java', ...javaPackage.split('.'));
    const classes = path.join(dir, 'classes');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.mkdirSync(classes, { recursive: true });
    fs.writeFileSync(path.join(javaDir, 'StaticCodeAnalyzerPlugin.java'), template.replace('__JAVA_PACKAGE__', javaPackage));
    fs.writeFileSync(path.join(classes, 'rules.json'), JSON.stringify(analyzer.rules, null, 2));
    await sh(`javac --release 21 -proc:none -nowarn -cp "${classpath}" -d "${classes}" "${path.join(javaDir, 'StaticCodeAnalyzerPlugin.java')}"`, ROOT, env);
    const jarPath = path.join(dir, `${id}.jar`);
    await sh(`jar --create --file "${jarPath}" -C "${classes}" .`, ROOT, env);

    const pkg = path.join(dir, 'package');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'Ballerina.toml'),
      `[package]\norg = "${analyzer.org}"\nname = "${analyzer.name}"\nversion = "0.1.0"\n`);
    fs.writeFileSync(path.join(pkg, 'CompilerPlugin.toml'),
      `[plugin]\nclass = "${javaPackage}.StaticCodeAnalyzerPlugin"\n\n[[dependency]]\npath = "../${id}.jar"\n`);
    fs.writeFileSync(path.join(pkg, 'main.bal'), '// Static code analyzer plugin package built by the bal scan playground.\n');
    fs.writeFileSync(path.join(pkg, 'README.md'), `Test analyzer ${analyzer.org}/${analyzer.name} for the bal scan playground.\n`);
    await sh(`${config.BAL_CMD || 'bal'} pack`, pkg, env);
    await sh(`${config.BAL_CMD || 'bal'} push --repository=local`, pkg, env);

    const localBala = path.join(REPOS, 'local', 'bala', analyzer.org, analyzer.name);
    const centralBala = path.join(REPOS, 'central.ballerina.io', 'bala', analyzer.org, analyzer.name);
    fs.rmSync(centralBala, { recursive: true, force: true });
    fs.cpSync(localBala, centralBala, { recursive: true });
    log(`copied ${localBala} -> ${centralBala}`);
    built.push({ org: analyzer.org, name: analyzer.name, version: '0.1.0', rules: analyzer.rules });
  }

  fs.writeFileSync(path.join(PLUGINS_OUT_DIR, 'manifest.json'), JSON.stringify({
    builtAt: new Date().toISOString(),
    scanCommandJar: scanJar,
    ballerinaHome: balHome,
    recorderPlatformPlugin: recorderJar,
    platforms: ['recorder', 'recorder2'],
    analyzers: built,
  }, null, 2));
  log(`done; manifest at ${path.join(PLUGINS_OUT_DIR, 'manifest.json')}`);
}

main().catch((err) => {
  console.error(`[plugins] ${err.message}`);
  process.exit(1);
});
