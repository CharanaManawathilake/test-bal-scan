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

export function summarizeIssues(data) {
  if (Array.isArray(data)) {
    return {
      format: 'json',
      total: data.length,
      suppressed: data.filter(isSuppressed).length,
      byRule: countBy(data, (i) => i?.rule?.id ?? i?.ruleID),
      bySource: countBy(data, (i) => i?.source),
      byFile: countBy(data, (i) => i?.fileName ?? i?.location?.filePath),
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
    };
  }
  return undefined;
}

const SUMMARY_LINE = /^\s*(\d+) issues?(?:\(s\))?(?:, (\d+) suppressed)?\s*$/m;

export function observeStep(result, changes, workDir) {
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
  }
  const lines = result.combined.split(/\r?\n/);
  obs.errors = lines.filter((l) => /^\s*ERROR\b|\berror:|^\s*ballerina: |Exception\b/.test(l)).map((l) => l.trim()).slice(0, 30);
  obs.warnings = lines.filter((l) => /^\s*(warning|WARNING)\b/.test(l)).map((l) => l.trim()).slice(0, 30);
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
    } else if (/\.html$/i.test(base)) {
      obs.reports.push({ path: rel, html: true });
    }
  }
  return obs;
}
