import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Facts pulled out of a step for the UI; nothing here passes or fails a case.

function tryJson(text) {
  const trimmed = (text || '').trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

// Older versions print status lines around the issues on stdout, so look for the JSON document inside it.
function embeddedJson(text) {
  const lines = (text || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*[[{]\s*$/.test(l) || /^\s*\[\s*\]\s*$/.test(l));
  if (start < 0) {
    return undefined;
  }
  const close = lines[start].trim().startsWith('[') ? ']' : '}';
  for (let end = lines.length - 1; end >= start; end--) {
    if (lines[end].trim().startsWith(close) || lines[end].trim().endsWith(close)) {
      const parsed = tryJson(lines.slice(start, end + 1).join('\n'));
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return undefined;
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const k = key(item) ?? 'unknown';
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

function isSuppressed(issue) {
  return Array.isArray(issue?.suppressions) && issue.suppressions.length > 0;
}

export const FINGERPRINT_KEY = 'ballerinaScanHash/v1';
const MAX_FINDINGS = 400;

// Fingerprint and baselineState facts (scan 0.15+); empty when the issues carry neither.
function fingerprintFacts(items) {
  const withFingerprint = items.filter((i) => i?.partialFingerprints && Object.keys(i.partialFingerprints).length);
  const withState = items.filter((i) => typeof i?.baselineState === 'string');
  if (!withFingerprint.length && !withState.length) {
    return {};
  }
  const values = withFingerprint.map((i) => i.partialFingerprints[FINGERPRINT_KEY]).filter(Boolean);
  return {
    fingerprinted: withFingerprint.length,
    fingerprintKeys: [...new Set(withFingerprint.flatMap((i) => Object.keys(i.partialFingerprints)))],
    uniqueFingerprints: new Set(values).size,
    withBaselineState: withState.length,
    baselineStates: withState.length ? countBy(withState, (i) => i.baselineState) : undefined,
    // SARIF says a direct producer should not write `fingerprints`
    withFingerprintsField: items.filter((i) => i?.fingerprints !== undefined).length,
  };
}

export function summarizeIssues(data) {
  if (Array.isArray(data)) {
    return {
      format: 'json',
      total: data.length,
      suppressed: data.filter(isSuppressed).length,
      byRule: countBy(data, (i) => i?.rule?.id ?? i?.ruleID),
      bySource: countBy(data, (i) => i?.source),
      byFile: countBy(data, (i) => i?.fileName ?? i?.location?.filePath),
      ...fingerprintFacts(data),
    };
  }
  if (data && Array.isArray(data.runs)) {
    const results = data.runs.flatMap((run) => run.results || []);
    return {
      format: 'sarif',
      total: results.length,
      suppressed: results.filter(isSuppressed).length,
      byRule: countBy(results, (r) => r.ruleId),
      byFile: countBy(results, (r) => r.locations?.[0]?.physicalLocation?.artifactLocation?.uri),
      rulesInDriver: data.runs.reduce((n, run) => n + (run.tool?.driver?.rules?.length || 0), 0),
      ...fingerprintFacts(results),
    };
  }
  return undefined;
}

// One row per issue, so the UI can follow each finding across steps by its fingerprint.
export function findingsOf(data) {
  let rows;
  if (Array.isArray(data)) {
    rows = data.map((i) => ({
      fp: i?.partialFingerprints?.[FINGERPRINT_KEY] ?? null,
      rule: i?.rule?.id ?? i?.ruleID ?? i?.ruleId ?? null,
      file: i?.location?.filePath ?? i?.fileName ?? i?.file ?? null,
      line: i?.location?.startLine ?? i?.startLine ?? null,
      snippet: i?.location?.snippet ?? null,
      state: i?.baselineState ?? null,
      suppressed: isSuppressed(i),
    }));
  } else if (data && Array.isArray(data.runs)) {
    rows = data.runs.flatMap((run) => run.results || []).map((r) => {
      const loc = r.locations?.[0]?.physicalLocation;
      return {
        fp: r.partialFingerprints?.[FINGERPRINT_KEY] ?? null,
        rule: r.ruleId ?? null,
        file: loc?.artifactLocation?.uri ?? null,
        line: loc?.region?.startLine ?? null,
        snippet: loc?.region?.snippet?.text ?? null,
        state: r.baselineState ?? null,
        suppressed: isSuppressed(r),
      };
    });
  } else {
    return undefined;
  }
  if (!rows.some((r) => r.fp || r.state)) {
    return undefined;
  }
  return { total: rows.length, truncated: rows.length > MAX_FINDINGS, items: rows.slice(0, MAX_FINDINGS) };
}

function isBaselineDocument(data) {
  return data && typeof data === 'object' && !Array.isArray(data) && 'fingerprint' in data && Array.isArray(data.issues)
    && 'version' in data;
}

// Reads a baseline file as it is after the step; an unreadable one is still reported, since that is often the point.
function readBaseline(workDir, rel) {
  const full = path.join(workDir, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return { path: rel, exists: false };
  }
  const text = fs.readFileSync(full, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { path: rel, exists: true, valid: false, problem: `not valid JSON (${err.message})` };
  }
  if (!isBaselineDocument(data)) {
    return { path: rel, exists: true, valid: false, problem: 'not a baseline document' };
  }
  return {
    path: rel,
    exists: true,
    valid: true,
    version: data.version,
    fingerprint: data.fingerprint,
    balScanVersion: data.balScanVersion,
    entries: data.issues.map((e) => ({
      fp: e?.fingerprint ?? null, rule: e?.ruleId ?? null, pkg: e?.package ?? null, file: e?.filePath ?? null,
      snippet: e?.snippet ?? null,
    })),
  };
}

const relTo = (workDir, abs) => path.relative(workDir, abs).split(path.sep).join('/');
const insideWork = (rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel);
// Fixture folders that hold variants and broken baselines to copy in; they are inputs, not baselines in use.
const NOT_SCANNED_DIRS = new Set(['target', 'variants', 'fixtures', '.git']);

// The baseline files a step could have used: the ones set in a Scan.toml, given to --baseline-path, or written.
function baselineCandidates(result, changes, workDir, cwd) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !NOT_SCANNED_DIRS.has(entry.name)) {
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === 'Scan.toml') {
        const toml = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        const table = toml.match(/^\s*\[baseline\][^[]*/m);
        const value = table?.[0].match(/^\s*path\s*=\s*"([^"]*)"/m)?.[1];
        const target = value && path.resolve(dir, value);
        // A missing file is only worth reporting for the Scan.toml of the folder the step ran in, or above it
        const governsCwd = cwd && !path.relative(dir, cwd).startsWith('..');
        if (target && (fs.existsSync(target) || governsCwd)) {
          found.add(relTo(workDir, target));
        }
      }
    }
  };
  walk(workDir);
  const option = result.command.match(/--baseline-path=("([^"]*)"|(\S+))/);
  const optionValue = option?.[2] ?? option?.[3];
  if (optionValue && cwd) {
    found.add(relTo(workDir, path.resolve(cwd, optionValue)));
  }
  for (const f of [...changes.created, ...changes.modified]) {
    if (/\.json$/i.test(f.path) && !/(^|\/)target\//.test(f.path) && f.size < 2_000_000) {
      try {
        if (isBaselineDocument(JSON.parse(fs.readFileSync(path.join(workDir, f.path), 'utf8')))) {
          found.add(f.path);
        }
      } catch {
        // Not JSON; not a baseline.
      }
    }
  }
  return [...found].filter(insideWork).sort();
}

const BASELINE_MESSAGE = /^(Saved \d+ entr(y|ies) to the baseline|The baseline already holds|Removed \d+ stale entr|Updated the fingerprints in the baseline|The baseline has no entries to remove)/;
const SUMMARY_LINE = /^\s*(\d+) (new )?issues?(?:\(s\))?(?:, (\d+) in baseline)?(?:, (\d+) suppressed)?\s*$/m;

export function observeStep(result, changes, workDir, cwd) {
  const obs = {};
  const stdoutJson = tryJson(result.stdout);
  obs.stdoutIsJson = stdoutJson !== undefined;
  const printed = stdoutJson ?? embeddedJson(result.stdout) ?? embeddedJson(result.combined);
  if (printed !== undefined) {
    obs.stdoutIssues = summarizeIssues(printed);
  }
  const summary = (result.stderr.match(SUMMARY_LINE) || result.stdout.match(SUMMARY_LINE));
  if (summary) {
    obs.summaryLine = summary[0].trim();
    obs.summary = {
      newIssues: Number(summary[1]),
      inBaseline: summary[3] !== undefined ? Number(summary[3]) : null,
      suppressed: summary[4] !== undefined ? Number(summary[4]) : 0,
    };
  }
  const lines = result.combined.split(/\r?\n/);
  obs.errors = lines.filter((l) => /^\s*ERROR\b|\berror:|^\s*ballerina: |Exception\b/.test(l)).map((l) => l.trim()).slice(0, 30);
  obs.warnings = lines.filter((l) => /^\s*(warning|WARNING)\b|^\s*bal scan: warning:/.test(l)).map((l) => l.trim()).slice(0, 30);
  const baselineMessages = lines.filter((l) => BASELINE_MESSAGE.test(l.trim())).map((l) => l.trim());
  if (baselineMessages.length) {
    obs.baselineMessages = baselineMessages;
  }
  const stale = lines.map((l) => l.match(/warning: (\d+) (?:entry|entries) of the baseline .+? match(?:es)? no issue/)).find(Boolean);
  if (stale) {
    obs.staleEntries = Number(stale[1]);
  }
  obs.reportLinks = lines.filter((l) => /file:\/\//.test(l)).map((l) => l.trim());

  // Reports the scan points at count too: rewriting a report with identical content leaves no file change.
  const linked = obs.reportLinks
    .map((l) => {
      try {
        return fileURLToPath(l.match(/file:\S+/)[0]);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((p) => path.relative(workDir, p).split(path.sep).join('/'))
    .filter((rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  const touched = [...new Set([...changes.created, ...changes.modified].map((f) => f.path).concat(linked))];
  obs.reports = [];
  for (const rel of touched) {
    const base = path.basename(rel);
    if (/^(scan_results\.json|scan_results\.sarif|.*\.sarif|ballerina-static-code-analysis-results\.json|platform-.*\.json)$/i.test(base)
        || /(^|\/)report\/.*\.json$/.test(rel)) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(workDir, rel), 'utf8'));
      } catch {
        continue;
      }
      const issues = summarizeIssues(data) ?? summarizeIssues(data?.issues);
      obs.reports.push({ path: rel, issues });
      // scan_results.json holds every issue, so it wins over SARIF and the printed (new only) issues
      const findings = findingsOf(data) ?? findingsOf(data?.issues);
      if (findings && (!obs.findings || /scan_results\.json$/.test(rel))) {
        obs.findings = { source: rel, ...findings };
      }
    } else if (/\.html$/i.test(base)) {
      obs.reports.push({ path: rel, html: true });
    }
  }
  if (!obs.findings && printed !== undefined) {
    const findings = findingsOf(printed);
    if (findings) {
      obs.findings = { source: 'stdout', ...findings };
    }
  }
  const baselines = baselineCandidates(result, changes, workDir, cwd).map((rel) => {
    const info = readBaseline(workDir, rel);
    info.change = changes.created.some((f) => f.path === rel) ? 'created'
      : changes.modified.some((f) => f.path === rel) ? 'modified'
        : changes.deleted.some((f) => f.path === rel) ? 'deleted' : null;
    return info;
  });
  if (baselines.length) {
    obs.baselines = baselines;
  }
  return obs;
}
