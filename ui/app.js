const UPSTREAM_REF = 'in-source-suppression';
const UPSTREAM = `https://github.com/ballerina-platform/static-code-analysis-tool/blob/${UPSTREAM_REF}/scan-command/src`;
const UTIL_TESTS = new Set(['ScanUtilsTest', 'ScanTomlWriterTest', 'DiagnosticLogTest']);
const NOISE = /(^|\/)target\/(cache|bin|build|backup|resources)(\/|$)/;

const state = {
  runs: [],
  cases: [],
  run: null,
  caseId: null,
  version: null,
  compare: null,
  view: 'side',
  diffOpts: loadDiffOpts(),
  diffStreams: {},
  diffPairs: [],
  diffRecords: null,
  category: '',
  tag: '',
  search: '',
  cache: new Map(),
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const fileUrl = (rel) => `/files/${rel.split('/').map(encodeURIComponent).join('/')}`;

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  }
  return res.json();
}

function loadDiffOpts() {
  const defaults = { mode: 'split', hideUnchanged: true, normalize: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('diffOpts') || '{}') };
  } catch {
    return defaults;
  }
}

function saveDiffOpts() {
  try {
    localStorage.setItem('diffOpts', JSON.stringify(state.diffOpts));
  } catch {
    // Storage unavailable; options just won't persist.
  }
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return { run: params.get('run'), case: params.get('case'), v: params.get('v'), cmp: params.get('cmp'), view: params.get('view') };
}

// cmp is "<spec>" for a version of the same run, or "<runId>|<spec>" for a version of another run.
function parseCompare(cmp) {
  if (!cmp) return null;
  const bar = cmp.indexOf('|');
  return bar < 0 ? { runId: state.run?.id, spec: cmp } : { runId: cmp.slice(0, bar), spec: cmp.slice(bar + 1) };
}

function writeHash() {
  const params = new URLSearchParams();
  if (state.run) params.set('run', state.run.id);
  if (state.caseId) params.set('case', state.caseId);
  if (state.version) params.set('v', state.version);
  if (state.compare) params.set('cmp', state.compare.runId === state.run?.id ? state.compare.spec : `${state.compare.runId}|${state.compare.spec}`);
  if (state.compare && state.view === 'diff') params.set('view', 'diff');
  history.replaceState(null, '', `#${params}`);
}

function upstreamLink(ref) {
  const m = ref.match(/^(\w+Test)#?(\w*)/);
  if (m) {
    const pkg = UTIL_TESTS.has(m[1]) ? 'utils' : 'internal';
    return `<a href="${UPSTREAM}/test/java/io/ballerina/scan/${pkg}/${m[1]}.java" target="_blank">${esc(ref)}</a>`;
  }
  const r = ref.match(/^(test-resources|command-outputs)\/(.+)$/);
  if (r && !r[2].includes('*')) {
    return `<a href="${UPSTREAM}/test/resources/${r[1]}/${r[2]}" target="_blank">${esc(ref)}</a>`;
  }
  return esc(ref);
}

// ---------------------------------------------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------------------------------------------
function runVersions() {
  return (state.run?.versions || []).filter((v) => v.dir || (isLive() && v.status === 'pending'));
}

function summaryFor(version, caseId) {
  return version.cases?.find((c) => c.id === caseId);
}

function isLive(run = state.run) {
  return run?.status === 'running';
}

// One of: done, running, pending, none.
function caseState(version, caseId, run = state.run) {
  if (summaryFor(version, caseId)) return 'done';
  if (!isLive(run)) return 'none';
  if (version.running?.includes(caseId)) return 'running';
  const inRun = run.caseIds ? run.caseIds.includes(caseId) : true;
  return inRun && ['pending', 'running'].includes(version.status) ? 'pending' : 'none';
}

function differs(caseId) {
  const keys = runVersions()
    .map((v) => summaryFor(v, caseId))
    .filter((s) => s && s.status === 'ran')
    .map((s) => JSON.stringify([s.exitCodes, s.issueTotals, s.errorFlags]));
  return new Set(keys).size > 1;
}

function cellHtml(summary, isDiff, live) {
  if (live === 'running') {
    return '<div class="cell running" title="running now"><div class="dots"><span class="dot live"></span></div><span>running</span></div>';
  }
  if (live === 'pending') {
    return '<div class="cell pending" title="waiting to run"><div class="dots"><span class="dot none"></span></div><span>pending</span></div>';
  }
  if (!summary) {
    return '<div class="cell"><div class="dots"><span class="dot none" title="not run"></span></div></div>';
  }
  if (summary.status !== 'ran') {
    return `<div class="cell skipped" title="${esc(summary.skipReason || summary.status)}"><div class="dots"></div></div>`;
  }
  const dots = summary.exitCodes.map((c, i) => {
    const err = summary.errorFlags?.[i];
    return `<span class="dot ${c !== 0 ? 'nz' : err ? 'err' : ''}" title="exit ${c}${err ? ', printed errors' : ''}"></span>`;
  }).join('');
  const issues = summary.issueTotals.find((n) => n != null);
  return `<div class="cell ${isDiff ? 'differs' : ''}"><div class="dots">${dots}</div>${issues != null ? `<span>${issues} issues</span>` : ''}</div>`;
}

function filteredCases() {
  const q = state.search.toLowerCase();
  return state.cases.filter((c) => (!state.category || c.category === state.category)
    && (!state.tag || c.tags.includes(state.tag))
    && (!q || `${c.id} ${c.title} ${c.tags.join(' ')}`.toLowerCase().includes(q)));
}

function renderSidebar() {
  const versions = runVersions();
  $('#versionHeader').innerHTML = versions.map((v) => `<span title="${esc(v.spec)}">${esc(v.spec)}</span>`).join('');
  let html = '';
  let group = '';
  for (const c of filteredCases()) {
    if (c.category !== group) {
      group = c.category;
      html += `<li class="group">${esc(group)}</li>`;
    }
    const isDiff = differs(c.id);
    html += `<li class="case-row ${c.id === state.caseId ? 'active' : ''}" data-id="${esc(c.id)}">
      <div class="names"><div class="name">${esc(c.name)}</div><div class="title">${esc(c.title)}</div></div>
      <div class="cells">${versions.map((v) => cellHtml(summaryFor(v, c.id), isDiff, caseState(v, c.id))).join('')}</div></li>`;
  }
  $('#caseList').innerHTML = html || '<li class="muted">No cases match.</li>';
}

// ---------------------------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------------------------
function progressHtml(run) {
  if (!isLive(run)) return '';
  const total = run.caseIds?.length ?? run.caseCount;
  const title = (id) => esc(state.cases.find((c) => c.id === id)?.title || '');
  const rows = run.versions.map((v) => {
    const done = v.cases?.length || 0;
    const running = v.running || [];
    const pct = total ? Math.round((done / total) * 100) : 0;
    const now = running.map((id) => `<li data-id="${esc(id)}"><span class="dot live"></span> <span class="mono">${esc(id)}</span> <span class="muted">${title(id)}</span></li>`).join('');
    return `<div class="progress-row">
      <div class="progress-head"><b>${esc(v.spec)}</b> <span class="muted">${esc(v.status)} · ${done}/${total} done${running.length ? ` · ${running.length} running` : ''}${v.status === 'running' ? ` · ${total - done - running.length} pending` : ''}</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      ${now ? `<ul class="live-list">${now}</ul>` : ''}</div>`;
  }).join('');
  return `<div class="progress"><div class="progress-title"><span class="dot live"></span> Run in progress, this page updates automatically</div>${rows}</div>`;
}

function renderOverview() {
  const run = state.run;
  if (!run) {
    $('#detail').innerHTML = `<div class="empty"><h1>No runs yet</h1>
      <p>Start one with <code>npm test</code> (or the <b>New run</b> button). Results land in <code>results/</code>.</p>
      <p>${state.cases.length} cases are defined under <code>cases/</code>.</p></div>`;
    return;
  }
  const versions = runVersions();
  const all = versions.flatMap((v) => v.cases || []);
  const ran = all.filter((c) => c.status === 'ran');
  const nonZero = ran.filter((c) => c.exitCodes.some((e) => e !== 0) || (c.errorFlags || []).some(Boolean)).length;
  const diffs = state.cases.filter((c) => differs(c.id)).length;
  const rows = filteredCases().map((c) => {
    const cells = versions.map((v) => {
      const s = summaryFor(v, c.id);
      const live = caseState(v, c.id);
      if (live === 'running') return '<td class="live-cell"><span class="dot live"></span> running</td>';
      if (live === 'pending') return '<td class="muted">pending</td>';
      if (!s) return '<td class="muted">-</td>';
      if (s.status !== 'ran') return `<td class="muted" title="${esc(s.skipReason)}">${esc(s.status)}</td>`;
      const errs = (s.errorFlags || []).filter(Boolean).length;
      return `<td class="mono">exit ${esc(s.exitCodes.join(' '))}${errs ? ` <span class="chip exitnz">${errs} with errors</span>` : ''}<br><span class="muted">issues ${esc(s.issueTotals.map((n) => n ?? '-').join(' '))}</span></td>`;
    }).join('');
    return `<tr data-id="${esc(c.id)}"><td class="mono">${esc(c.id)}${differs(c.id) ? ' <span class="chip diff">differs</span>' : ''}</td>${cells}</tr>`;
  }).join('');
  const scroll = $('#detail').scrollTop;
  $('#detail').innerHTML = `
    <h1>Run ${esc(run.id)}</h1>
    <div class="muted">${esc(run.balVersion.split('\n')[0] || '')} · started ${esc(new Date(run.startedAt).toLocaleString())}
      · status ${esc(run.status)} · scan tool active before the run: ${esc(run.originalActiveScanVersion || '?')}
      · Central: ${esc(run.central || 'default')}</div>
    ${progressHtml(run)}
    <div class="stat-row">
      <div class="stat"><div class="v">${versions.length}</div><div class="l">versions (${esc(versions.map((v) => `${v.spec}${v.central && !v.spec.includes('@') ? ` [${v.central}]` : ''}: ${v.status}`).join(', '))})</div></div>
      <div class="stat"><div class="v">${ran.length}</div><div class="l">case runs recorded</div></div>
      <div class="stat"><div class="v">${all.length - ran.length}</div><div class="l">skipped</div></div>
      <div class="stat"><div class="v">${nonZero}</div><div class="l">with a non-zero exit or printed errors</div></div>
      <div class="stat"><div class="v">${diffs}</div><div class="l">differ between versions</div></div>
    </div>
    <p class="muted">Exit codes and printed issue counts per scan step (setup steps excluded). On Windows <code>bal.bat</code> exits 0 even when a command fails, so steps that printed errors are flagged separately. Nothing here is asserted; select a case to see what happened.</p>
    <table class="overview"><thead><tr><th>case</th>${versions.map((v) => `<th>${esc(v.spec)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  $('#detail').scrollTop = scroll;
  if (run.status === 'interrupted') {
    $('#detail').insertAdjacentHTML('afterbegin', '<p class="chip exitnz">The runner process for this run is gone (killed or crashed); results stop where it left off.</p>');
  }
  for (const v of (run.versions || []).filter((x) => x.toolChangedDuringRun)) {
    $('#detail').insertAdjacentHTML('afterbegin', `<p class="chip exitnz">scan ${esc(v.spec)}: the tool JAR changed during the run (${esc(v.toolBefore?.modified)} -> ${esc(v.toolAfter?.modified)}); later cases used the new build</p>`);
  }
  for (const v of (run.versions || []).filter((x) => x.status === 'unavailable')) {
    $('#detail').insertAdjacentHTML('afterbegin', `<p class="chip exitnz">scan ${esc(v.spec)} could not be activated (active: ${esc(v.activeAfterSwitch)}); see
      <a href="${fileUrl(`results/${run.id}/${v.dir}/tool-switch.txt`)}" target="_blank">tool-switch.txt</a></p>`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Case detail
// ---------------------------------------------------------------------------------------------------------------
async function loadCaseRecord(version, run = state.run) {
  const def = state.cases.find((c) => c.id === state.caseId);
  const live = caseState(version, def.id, run);
  if (live === 'pending' || !version.dir) {
    return { version: version.spec, pending: true };
  }
  const key = `${run.id}|${version.dir}|${def.id}`;
  if (!state.cache.has(key)) {
    const p = api(`/api/runs/${encodeURIComponent(run.id)}/${encodeURIComponent(version.dir)}/${def.category}/${def.name}`)
      .catch((err) => ({ error: err.message }));
    state.cache.set(key, p);
    // Only finished records are stable enough to cache.
    p.then((r) => { if (r.error || r.status === 'running') state.cache.delete(key); });
  }
  const record = await state.cache.get(key);
  return record.error && live === 'running' ? { version: version.spec, starting: true } : record;
}

function recordSig(r) {
  return r ? JSON.stringify([r.status, r.error, r.pending, r.starting, r.steps?.length, r.currentStep?.index]) : '';
}

function ruleCounts(byRule) {
  return Object.entries(byRule || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join('  ');
}

function obsHtml(step, record) {
  const o = step.observations || {};
  const parts = [];
  if (o.stdoutIssues) {
    parts.push(`<div><span class="k">printed issues</span><b>${o.stdoutIssues.total}</b> (${esc(o.stdoutIssues.format)})${o.stdoutIssues.suppressed ? `, ${o.stdoutIssues.suppressed} suppressed` : ''}
      ${o.stdoutIsJson ? '<span class="chip">stdout is pure JSON</span>' : ''} <span class="rule-counts">${esc(ruleCounts(o.stdoutIssues.byRule))}</span></div>`);
  }
  if (o.summaryLine) parts.push(`<div><span class="k">summary</span>${esc(o.summaryLine)}</div>`);
  for (const r of o.reports || []) {
    const link = `<a href="${fileUrl(`${record.workDir}/${r.path}`)}" target="_blank">${esc(r.path)}</a>`;
    if (r.html) {
      parts.push(`<div><span class="k">HTML report</span>${link}</div>`);
    } else {
      parts.push(`<div><span class="k">report</span>${link}${r.issues ? ` · ${r.issues.total} issues${r.issues.suppressed ? `, ${r.issues.suppressed} suppressed` : ''}
        <span class="rule-counts">${esc(ruleCounts(r.issues.byRule))}</span>` : ''}</div>`);
    }
  }
  if (o.warnings?.length) parts.push(`<div><span class="k">warnings</span>${o.warnings.map(esc).join('<br>')}</div>`);
  if (o.errors?.length) parts.push(`<div><span class="k">errors</span>${o.errors.map(esc).join('<br>')}</div>`);
  return parts.length ? `<div class="obs">${parts.join('')}</div>` : '';
}

function filesHtml(step, record) {
  const ch = step.changes || { created: [], modified: [], deleted: [] };
  const total = ch.created.length + ch.modified.length + ch.deleted.length;
  if (!total) {
    return '<details class="files"><summary>no file changes</summary></details>';
  }
  const item = (cls, sign, f, linkable) => `<li class="${cls}">${sign} ${linkable ? `<a href="${fileUrl(`${record.workDir}/${f.path}`)}" target="_blank">${esc(f.path)}</a>` : esc(f.path)} <span class="muted">${f.size} B</span></li>`;
  const visible = (list) => list.filter((f) => !NOISE.test(f.path));
  const hidden = total - visible(ch.created).length - visible(ch.modified).length - visible(ch.deleted).length;
  const main = [
    ...visible(ch.created).map((f) => item('c', '+', f, true)),
    ...visible(ch.modified).map((f) => item('m', '~', f, true)),
    ...visible(ch.deleted).map((f) => item('d', '-', f, false)),
  ].join('');
  const noise = [...ch.created, ...ch.modified].filter((f) => NOISE.test(f.path)).map((f) => item('c', '+', f, true)).join('');
  return `<details class="files" open><summary>files: ${ch.created.length} created, ${ch.modified.length} modified, ${ch.deleted.length} deleted</summary>
    <ul class="file-list">${main}</ul>
    ${hidden ? `<details><summary>${hidden} more under target/{cache,bin,build,backup,resources}</summary><ul class="file-list">${noise}</ul></details>` : ''}</details>`;
}

function stepHtml(step, record, otherStep, slot) {
  const isDiff = otherStep && (otherStep.exitCode !== step.exitCode
    || (otherStep.observations?.stdoutIssues?.total ?? null) !== (step.observations?.stdoutIssues?.total ?? null));
  const id = `${slot}-${step.index}`;
  return `<div class="step ${isDiff ? 'differs' : ''}">
    <div class="step-head"><span class="n">${step.index}. ${esc(step.name)}</span>
      ${step.setup ? '<span class="chip setup">setup</span>' : ''}
      <span class="chip ${step.exitCode === 0 ? 'exit0' : 'exitnz'}">exit ${esc(step.exitCode)}${step.timedOut ? ' (timeout)' : ''}</span>
      ${step.observations?.errors?.length ? '<span class="chip exitnz">printed errors</span>' : ''}
      ${isDiff ? '<span class="chip diff">differs</span>' : ''}
      <span class="dur">${fmtMs(step.durationMs)}</span><span class="spacer"></span>
      <a href="${fileUrl(step.outputDir)}" target="_blank" class="muted">raw output</a></div>
    <div class="cmd"><span class="cwd">${esc(step.cwd)}&gt;</span> ${esc(step.command)}</div>
    ${step.note ? `<div class="note">${esc(step.note)}</div>` : ''}
    ${obsHtml(step, record)}
    ${filesHtml(step, record)}
    <div class="term-tabs" data-step="${esc(id)}">
      <button class="on" data-stream="combined">combined</button>
      <button data-stream="stdout">stdout (${step.stdoutBytes} B)</button>
      <button data-stream="stderr">stderr (${step.stderrBytes} B)</button></div>
    <pre class="term ${step.combined ? '' : 'empty-out'}" data-step="${esc(id)}">${esc(step.combined || '(no output)')}</pre>
  </div>`;
}

function liveStepHtml(record, slot) {
  const s = record.currentStep;
  if (!s) {
    return `<div class="step live"><div class="step-head"><span class="dot live"></span><span class="n">between steps...</span></div></div>`;
  }
  return `<div class="step live">
    <div class="step-head"><span class="dot live"></span><span class="n">${s.index}. ${esc(s.name)}</span>
      ${s.setup ? '<span class="chip setup">setup</span>' : ''}
      <span class="chip running">running</span>
      <span class="dur elapsed" data-since="${esc(s.startedAt)}"></span></div>
    <div class="cmd">${esc(s.command)}</div>
    <pre class="term live-term ${s.combined ? '' : 'empty-out'}" data-slot="${slot}">${esc(s.combined || '(no output yet)')}</pre>
  </div>`;
}

function recordColumn(record, other, slot = 'a', run = state.run) {
  if (record.pending) {
    return '<p class="muted"><span class="dot none"></span> Pending. Results will appear here automatically once this case runs.</p>';
  }
  if (record.starting) {
    return '<p class="muted"><span class="dot live"></span> Starting...</p>';
  }
  if (record.error) {
    return `<p class="muted">${esc(record.error)}</p>`;
  }
  const running = record.status === 'running';
  if (record.status !== 'ran' && !running) {
    return `<p class="chip">${esc(record.status)}: ${esc(record.skipReason)}</p>`;
  }
  const links = `<div class="links">
    <a href="${fileUrl(`${record.workDir}`)}" target="_blank">work folder</a>
    ${running ? '' : `<a href="${fileUrl(record.workDir.replace(/\/work$/, '/terminal.txt'))}" target="_blank">terminal.txt</a>`}</div>`;
  const banner = running
    ? (isLive(run) ? `<p class="muted">Running: step ${record.currentStep?.index ?? record.steps.length} of ${record.stepCount ?? '?'}. Completed steps appear as they finish.</p>`
      : '<p class="chip exitnz">This case never finished (the run was interrupted).</p>')
    : '';
  const steps = record.steps.map((s) => stepHtml(s, record, other?.steps?.find((o) => o.index === s.index), slot)).join('');
  return banner + links + steps + (running && isLive(run) ? liveStepHtml(record, slot) : '');
}

// ---------------------------------------------------------------------------------------------------------------
// Text diff (Myers, line level, with word-level highlights inside changed lines)
// ---------------------------------------------------------------------------------------------------------------
const MAX_EDIT_DISTANCE = 3000;
const MAX_DIFF_LINES = 40000;
const DIFF_CONTEXT = 3;
let foldSeq = 0;

// Returns ops as [kind, indexInA, indexInB] with kind '=', '-' or '+'.
function diffSeq(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push(['=', i, i]);
  ops.push(...myers(a, b, start, endA, start, endB));
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push(['=', i, j]);
  return ops;
}

function myers(a, b, a0, a1, b0, b1) {
  const n = a1 - a0;
  const m = b1 - b0;
  const replaceAll = () => [
    ...Array.from({ length: n }, (_, i) => ['-', a0 + i, -1]),
    ...Array.from({ length: m }, (_, j) => ['+', -1, b0 + j]),
  ];
  if (!n || !m) return replaceAll();
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= Math.min(max, MAX_EDIT_DISTANCE); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1));
        return backtrack(trace, n, m, a0, b0);
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return replaceAll();
}

function backtrack(trace, n, m, a0, b0) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k) => prev[k + d - 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(['=', a0 + --x, b0 + --y]); }
    if (x === prevX) ops.push(['+', -1, b0 + --y]);
    else ops.push(['-', a0 + --x, -1]);
  }
  while (x > 0 && y > 0) ops.push(['=', a0 + --x, b0 + --y]);
  return ops.reverse();
}

function inlineDiff(left, right) {
  if (left.length + right.length > 4000) return [esc(left), esc(right)];
  const ta = left.match(/\w+|\s+|[^\w\s]/g) || [];
  const tb = right.match(/\w+|\s+|[^\w\s]/g) || [];
  let l = '';
  let r = '';
  let run = null;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    if (run === '-') l += `<span class="w-del">${esc(buf)}</span>`;
    else if (run === '+') r += `<span class="w-ins">${esc(buf)}</span>`;
    else { l += esc(buf); r += esc(buf); }
    buf = '';
  };
  for (const [kind, i, j] of diffSeq(ta, tb)) {
    if (kind !== run) { flush(); run = kind; }
    buf += kind === '+' ? tb[j] : ta[i];
  }
  flush();
  return [l, r];
}

function toLines(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Rows are {t:'='|'chg', ...}; changed blocks pair the i-th removed line with the i-th added one for word highlights.
function diffRows(A, B) {
  const rows = [];
  let block = null;
  const close = () => {
    if (!block) return;
    const pairs = Math.min(block.dels.length, block.ins.length);
    block.delHtml = block.dels.map((i) => esc(A[i]));
    block.insHtml = block.ins.map((j) => esc(B[j]));
    for (let p = 0; p < pairs; p++) {
      [block.delHtml[p], block.insHtml[p]] = inlineDiff(A[block.dels[p]], B[block.ins[p]]);
    }
    rows.push(block);
    block = null;
  };
  for (const [kind, i, j] of diffSeq(A, B)) {
    if (kind === '=') {
      close();
      rows.push({ t: '=', a: i, b: j });
    } else {
      block ||= { t: 'chg', dels: [], ins: [] };
      (kind === '-' ? block.dels : block.ins).push(kind === '-' ? i : j);
    }
  }
  close();
  return rows;
}

function renderDiff(textA, textB) {
  const A = toLines(textA);
  const B = toLines(textB);
  if (!A.length && !B.length) {
    return { html: '<div class="diff-empty">(empty on both sides)</div>', added: 0, removed: 0, changed: false };
  }
  if (A.length > MAX_DIFF_LINES || B.length > MAX_DIFF_LINES) {
    return { html: '<div class="diff-empty">Too large to diff in the browser; use the raw output links.</div>', added: 0, removed: 0, changed: textA !== textB };
  }
  const rows = diffRows(A, B);
  const removed = rows.reduce((n, r) => n + (r.t === 'chg' ? r.dels.length : 0), 0);
  const added = rows.reduce((n, r) => n + (r.t === 'chg' ? r.ins.length : 0), 0);
  const split = state.diffOpts.mode === 'split';
  const cols = split ? 4 : 3;
  const eqRow = (r) => (split
    ? `<tr><td class="ln">${r.a + 1}</td><td class="code">${esc(A[r.a])}</td><td class="ln">${r.b + 1}</td><td class="code">${esc(B[r.b])}</td></tr>`
    : `<tr><td class="ln">${r.a + 1}</td><td class="ln">${r.b + 1}</td><td class="code"><span class="sign"> </span>${esc(A[r.a])}</td></tr>`);
  const chgRows = (r) => {
    if (split) {
      let html = '';
      for (let p = 0; p < Math.max(r.dels.length, r.ins.length); p++) {
        const left = p < r.dels.length ? `<td class="ln del">${r.dels[p] + 1}</td><td class="code del">${r.delHtml[p]}</td>` : '<td class="ln filler"></td><td class="code filler"></td>';
        const right = p < r.ins.length ? `<td class="ln ins">${r.ins[p] + 1}</td><td class="code ins">${r.insHtml[p]}</td>` : '<td class="ln filler"></td><td class="code filler"></td>';
        html += `<tr>${left}${right}</tr>`;
      }
      return html;
    }
    return r.dels.map((i, p) => `<tr><td class="ln del">${i + 1}</td><td class="ln del"></td><td class="code del"><span class="sign">-</span>${r.delHtml[p]}</td></tr>`).join('')
      + r.ins.map((j, p) => `<tr><td class="ln ins"></td><td class="ln ins">${j + 1}</td><td class="code ins"><span class="sign">+</span>${r.insHtml[p]}</td></tr>`).join('');
  };
  let body = '<tbody>';
  for (let i = 0; i < rows.length;) {
    if (rows[i].t !== '=') {
      body += chgRows(rows[i++]);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].t === '=') j++;
    const keepHead = i === 0 ? 0 : DIFF_CONTEXT;
    const keepTail = j === rows.length ? 0 : DIFF_CONTEXT;
    const hidden = j - i - keepHead - keepTail;
    if (state.diffOpts.hideUnchanged && hidden > 1) {
      body += rows.slice(i, i + keepHead).map(eqRow).join('');
      const id = `fold-${++foldSeq}`;
      body += `</tbody><tbody><tr class="fold"><td colspan="${cols}"><button type="button" data-unfold="${id}">Show ${hidden} unchanged line${hidden === 1 ? '' : 's'}</button></td></tr></tbody>
        <tbody id="${id}" hidden>${rows.slice(i + keepHead, j - keepTail).map(eqRow).join('')}</tbody><tbody>`;
      body += rows.slice(j - keepTail, j).map(eqRow).join('');
    } else {
      body += rows.slice(i, j).map(eqRow).join('');
    }
    i = j;
  }
  body += '</tbody>';
  const colgroup = split
    ? '<colgroup><col class="c-ln"><col><col class="c-ln"><col></colgroup>'
    : '<colgroup><col class="c-ln"><col class="c-ln"><col></colgroup>';
  return { html: `<table class="diff ${split ? 'split' : 'unified'}">${colgroup}${body}</table>`, added, removed, changed: added + removed > 0 };
}

function diffStat(d) {
  return d.changed ? `<span class="stat-ins">+${d.added}</span> <span class="stat-del">-${d.removed}</span>` : '<span class="muted">no changes</span>';
}

// ---------------------------------------------------------------------------------------------------------------
// Diff view between two case records (any two versions, from the same run or from different runs)
// ---------------------------------------------------------------------------------------------------------------
const stripAnsi = (s) => String(s ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

// Run ids and version folder names appear in absolute paths in the output; replace them so they don't show as changes.
function normalizer(ctx) {
  const tokens = [[ctx.runId, '<run>'], [ctx.dir, '<version>']].filter(([t]) => t);
  return (text) => {
    let out = stripAnsi(text);
    if (state.diffOpts.normalize) {
      for (const [t, rep] of tokens) out = out.split(t).join(rep);
    }
    return out;
  };
}

function stepSummaryText(step) {
  if (!step) return '';
  const o = step.observations || {};
  const lines = [`command: ${step.command}`, `cwd: ${step.cwd}`, `exit code: ${step.exitCode}${step.timedOut ? ' (timed out)' : ''}`];
  if (o.stdoutIssues) {
    lines.push(`printed issues: ${o.stdoutIssues.total} (${o.stdoutIssues.format}), ${o.stdoutIssues.suppressed || 0} suppressed`);
    for (const [k, n] of Object.entries(o.stdoutIssues.byRule || {}).sort((x, y) => x[0].localeCompare(y[0], undefined, { numeric: true }))) {
      lines.push(`  ${k}: ${n}`);
    }
  }
  if (o.summaryLine) lines.push(`summary: ${o.summaryLine}`);
  for (const r of o.reports || []) {
    lines.push(`report: ${r.path}${r.issues ? ` (${r.issues.total} issues, ${r.issues.suppressed || 0} suppressed)` : ''}`);
  }
  for (const e of o.errors || []) lines.push(`error: ${e}`);
  for (const w of o.warnings || []) lines.push(`warning: ${w}`);
  const ch = step.changes || {};
  for (const kind of ['created', 'modified', 'deleted']) {
    for (const f of (ch[kind] || []).filter((x) => !NOISE.test(x.path))) lines.push(`${kind}: ${f.path}`);
  }
  return lines.join('\n');
}

function streamDiff(pair, stream) {
  return renderDiff(pair.normA(pair.sa?.[stream] || ''), pair.normB(pair.sb?.[stream] || ''));
}

function stepDiffHtml(pair, i) {
  const { sa, sb } = pair;
  const s = sa || sb;
  const stream = state.diffStreams[`${state.caseId}:${s.index}`] || 'combined';
  const sum = renderDiff(pair.normA(stepSummaryText(sa)), pair.normB(stepSummaryText(sb)));
  const out = streamDiff(pair, stream);
  const streamDiffers = (name) => pair.normA(sa?.[name] || '') !== pair.normB(sb?.[name] || '');
  const anyOutput = ['combined', 'stdout', 'stderr'].some(streamDiffers);
  const exit = sa && sb
    ? (sa.exitCode === sb.exitCode ? `<span class="chip ${sa.exitCode === 0 ? 'exit0' : 'exitnz'}">exit ${esc(sa.exitCode)}</span>`
      : `<span class="chip exitnz">exit ${esc(sa.exitCode)} → ${esc(sb.exitCode)}</span>`)
    : '';
  const presence = !sa ? '<span class="chip ins-chip">only on the right</span>' : !sb ? '<span class="chip del-chip">only on the left</span>' : '';
  const identical = !sum.changed && !anyOutput;
  pair.identical = identical;
  const nameDiff = sa && sb && sa.name !== sb.name ? ` <span class="muted">vs ${esc(sb.name)}</span>` : '';
  return `<div class="step diff-step ${identical ? 'same' : 'differs'}">
    <div class="step-head"><span class="n">${s.index}. ${esc(s.name)}</span>${nameDiff}
      ${s.setup ? '<span class="chip setup">setup</span>' : ''}${exit}${presence}
      <span class="chip ${identical ? '' : 'diff'}">${identical ? 'identical' : 'differs'}</span>
      <span class="dur">${fmtMs(sa?.durationMs)}${sa && sb ? ' / ' : ''}${fmtMs(sb?.durationMs)}</span></div>
    <details class="diff-sec" ${sum.changed ? 'open' : ''}><summary>Command, exit code and observations · ${diffStat(sum)}</summary>${sum.html}</details>
    <div class="diff-sec">
      <div class="diff-streams" data-pair="${i}">${['combined', 'stdout', 'stderr'].map((name) => `<button type="button" data-stream="${name}" class="${name === stream ? 'on' : ''}">${name}${streamDiffers(name) ? ' <span class="mark"></span>' : ''}</button>`).join('')}
        <span class="spacer"></span><span class="diff-out-stat">${diffStat(out)}</span></div>
      <div class="diff-out" data-pair="${i}">${out.html}</div>
    </div>
  </div>`;
}

function workFiles(record) {
  const files = new Set();
  for (const s of record?.steps || []) {
    for (const f of [...(s.changes?.created || []), ...(s.changes?.modified || [])]) {
      if (!NOISE.test(f.path)) files.add(f.path);
    }
    for (const r of s.observations?.reports || []) files.add(r.path);
  }
  return files;
}

function recordState(r) {
  if (r.pending) return 'pending';
  if (r.starting) return 'starting';
  if (r.error) return r.error;
  if (r.status !== 'ran' && r.status !== 'running') return `${r.status}: ${r.skipReason || ''}`;
  return null;
}

function diffViewHtml(a, b, ctxA, ctxB) {
  const notReady = [[a, ctxA], [b, ctxB]].map(([r, c]) => [recordState(r), c]).filter(([s]) => s);
  if (notReady.length) {
    return `<div class="diff-view"><p class="muted">Both sides need recorded steps to diff.</p>
      ${notReady.map(([s, c]) => `<p><b>${esc(c.label)}</b>: <span class="muted">${esc(s)}</span></p>`).join('')}</div>`;
  }
  const normA = normalizer(ctxA);
  const normB = normalizer(ctxB);
  const indexes = [...new Set([...a.steps, ...b.steps].map((s) => s.index))].sort((x, y) => x - y);
  state.diffPairs = indexes.map((idx) => ({
    sa: a.steps.find((s) => s.index === idx), sb: b.steps.find((s) => s.index === idx), normA, normB,
  }));
  state.diffRecords = { a, b, normA, normB };
  const files = [...new Set([...workFiles(a), ...workFiles(b)])].sort();
  const steps = state.diffPairs.map(stepDiffHtml).join('');
  const nDiff = state.diffPairs.filter((p) => !p.identical).length;
  const running = [a, b].some((r) => r.status === 'running');
  const opt = (key, label) => `<label class="diff-opt"><input type="checkbox" data-opt="${key}" ${state.diffOpts[key] ? 'checked' : ''}> ${label}</label>`;
  return `<div class="diff-view">
    <div class="diff-bar">
      <span class="legend"><span class="sw del"></span>${esc(ctxA.label)}</span>
      <span class="legend"><span class="sw ins"></span>${esc(ctxB.label)}</span>
      <span class="spacer"></span>
      <div class="seg small"><button type="button" data-diffmode="split" class="${state.diffOpts.mode === 'split' ? 'on' : ''}">Split</button><button type="button" data-diffmode="unified" class="${state.diffOpts.mode === 'unified' ? 'on' : ''}">Unified</button></div>
      ${opt('hideUnchanged', 'Hide unchanged lines')}
      ${opt('normalize', 'Ignore run and version folder names')}
    </div>
    <p class="muted">${nDiff} of ${state.diffPairs.length} steps differ. Steps are paired by their index; red is the left side, green is the right.</p>
    ${running ? '<div class="step live diff-live"><div class="step-head"><span class="dot live"></span><span class="n">One side is still running; the diff covers the steps finished so far.</span></div></div>' : ''}
    ${steps}
    ${files.length ? `<h3 class="diff-h">Files in the work folder <span class="muted">(final contents, loaded when opened)</span></h3>
      ${files.map((f) => `<details class="step diff-file" data-file="${esc(f)}"><summary><span class="mono">${esc(f)}</span>
        ${!workFiles(a).has(f) ? '<span class="chip ins-chip">only on the right</span>' : !workFiles(b).has(f) ? '<span class="chip del-chip">only on the left</span>' : ''}
        <span class="file-stat"></span></summary><div class="file-diff muted">Loading...</div></details>`).join('')}` : ''}
  </div>`;
}

function prettyJson(text) {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

async function loadFileDiff(det) {
  if (det.dataset.loaded) return;
  det.dataset.loaded = '1';
  const { a, b, normA, normB } = state.diffRecords || {};
  const rel = det.dataset.file;
  const get = async (rec) => {
    if (!workFiles(rec).has(rel)) return '';
    const res = await fetch(fileUrl(`${rec.workDir}/${rel}`));
    return res.ok ? res.text() : '';
  };
  try {
    const [ta, tb] = await Promise.all([get(a), get(b)]);
    const d = renderDiff(prettyJson(normA(ta)), prettyJson(normB(tb)));
    det.querySelector('.file-diff').outerHTML = d.html;
    det.querySelector('.file-stat').innerHTML = diffStat(d);
  } catch (err) {
    det.querySelector('.file-diff').textContent = `Failed to load: ${err.message}`;
  }
}

function compareTarget() {
  if (!state.compare || !state.run) return null;
  const run = state.compare.runId === state.run.id ? state.run : state.runs.find((r) => r.id === state.compare.runId);
  const version = run?.versions?.find((v) => v.spec === state.compare.spec);
  if (!version || (run.id === state.run.id && version.spec === state.version)) return null;
  return { run, version };
}

function sideLabel(run, version) {
  return run.id === state.run.id ? version.spec : `${version.spec} · ${run.id}`;
}

function compareOptionsHtml(caseId) {
  const opt = (run, v) => {
    const on = state.compare?.runId === run.id && state.compare?.spec === v.spec;
    return `<option value="${esc(`${run.id}|${v.spec}`)}" ${on ? 'selected' : ''}>${esc(v.spec)}${v.central && !v.spec.includes('@') ? ` [${esc(v.central)}]` : ''}</option>`;
  };
  const groups = [];
  const own = runVersions().filter((v) => v.spec !== state.version);
  if (own.length) groups.push(`<optgroup label="This run">${own.map((v) => opt(state.run, v)).join('')}</optgroup>`);
  for (const r of state.runs) {
    if (r.id === state.run.id) continue;
    const vs = (r.versions || []).filter((v) => v.dir && caseState(v, caseId, r) !== 'none');
    if (vs.length) groups.push(`<optgroup label="Run ${esc(r.id)}">${vs.map((v) => opt(r, v)).join('')}</optgroup>`);
  }
  return groups.join('');
}

let renderSeq = 0;
async function renderCase({ quiet = false } = {}) {
  const token = ++renderSeq;
  const def = state.cases.find((c) => c.id === state.caseId);
  if (!def) {
    renderOverview();
    return;
  }
  const versions = runVersions();
  if (!state.version || !versions.some((v) => v.spec === state.version)) {
    state.version = versions[0]?.spec || null;
  }
  const head = `
    <div class="case-id">${esc(def.id)}</div>
    <h1>${esc(def.title)}</h1>
    <div class="chips">${def.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
      ${def.requires?.plugins ? '<span class="chip">needs test plugins</span>' : ''}
      ${(def.requires?.env || []).map((e) => `<span class="chip">needs ${esc(e)}</span>`).join('')}</div>
    ${def.description ? `<p class="desc">${esc(def.description)}</p>` : ''}
    ${def.notes ? `<p class="desc muted">${esc(def.notes)}</p>` : ''}
    ${def.upstream.length ? `<div class="muted" style="font-size:12.5px">Upstream references:</div><ul class="refs">${def.upstream.map((r) => `<li>${upstreamLink(r)}</li>`).join('')}</ul>` : ''}
    <div class="links"><a href="${fileUrl(def.path)}" target="_blank">fixture source (${esc(def.path)})</a>
      <a href="${fileUrl(`${def.path}/case.json`)}" target="_blank">case.json</a></div>`;
  if (!state.run) {
    $('#detail').innerHTML = `${head}<p class="muted">No run selected.</p>`;
    return;
  }
  const target = compareTarget();
  const options = compareOptionsHtml(def.id);
  const tabs = `<div class="version-tabs">${versions.map((v) => `<button data-v="${esc(v.spec)}" class="${v.spec === state.version ? 'on' : ''}">${esc(v.spec)}</button>`).join('')}
    ${options ? `<label class="compare-toggle">compare with <select id="compareSelect"><option value="">-</option>${options}</select></label>` : ''}
    ${target ? `<div class="seg view-seg"><button type="button" data-view="side" class="${state.view !== 'diff' ? 'on' : ''}">Side by side</button><button type="button" data-view="diff" class="${state.view === 'diff' ? 'on' : ''}">Diff</button></div>` : ''}</div>`;
  if (!quiet) {
    $('#detail').innerHTML = `${head}${tabs}<div id="caseBody" class="muted">Loading...</div>`;
  }

  const primary = versions.find((v) => v.spec === state.version);
  if (!primary) {
    $('#detail').innerHTML = `${head}${tabs}<div id="caseBody" class="muted">This run has no usable versions.</div>`;
    return;
  }
  const [a, b] = await Promise.all([loadCaseRecord(primary), target ? loadCaseRecord(target.version, target.run) : null]);
  if (token !== renderSeq) return;
  const ctxA = { runId: state.run.id, dir: primary.dir, label: sideLabel(state.run, primary) };
  const ctxB = target && { runId: target.run.id, dir: target.version.dir, label: sideLabel(target.run, target.version) };
  let body;
  if (!target) {
    body = `<div class="columns">${recordColumn(a)}</div>`;
  } else if (state.view === 'diff') {
    body = diffViewHtml(a, b, ctxA, ctxB);
  } else {
    body = `<div class="columns two"><div><div class="col-title">${esc(ctxA.label)}</div>${recordColumn(a, b, 'a')}</div>
       <div><div class="col-title">${esc(ctxB.label)}</div>${recordColumn(b, a, 'b', target.run)}</div></div>`;
  }
  const scroll = $('#detail').scrollTop;
  $('#detail').innerHTML = `${head}${tabs}<div id="caseBody">${body}</div>`;
  $('#detail').scrollTop = scroll;
  document.querySelectorAll('.live-term').forEach((pre) => { pre.scrollTop = pre.scrollHeight; });
  tickElapsed();
  const records = { a, b };
  state.shown = { caseId: def.id, runId: state.run.id, sig: [a, b].filter(Boolean).map(recordSig).join('|') };
  document.querySelectorAll('.term-tabs').forEach((tabsEl) => {
    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const [slot, idx] = tabsEl.dataset.step.split('-');
      const rec = records[slot];
      const step = rec?.steps.find((s) => s.index === Number(idx));
      const pre = tabsEl.nextElementSibling;
      const text = step?.[btn.dataset.stream] || '';
      pre.textContent = text || '(no output)';
      pre.classList.toggle('empty-out', !text);
      tabsEl.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === btn));
    });
  });
}

function render() {
  renderSidebar();
  writeHash();
  if (state.caseId) {
    renderCase();
  } else {
    renderSeq++;
    renderOverview();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Runs and jobs
// ---------------------------------------------------------------------------------------------------------------
function renderRunSelect() {
  $('#runSelect').innerHTML = state.runs.map((r) => `<option value="${esc(r.id)}" ${r.id === state.run?.id ? 'selected' : ''}>${esc(r.id)}${r.status !== 'done' ? ` (${esc(r.status)})` : ''}</option>`).join('')
    || '<option>no runs</option>';
  const r = state.run;
  $('#runMeta').textContent = r ? `${runVersions().map((v) => v.spec).join(', ')} · ${r.caseCount} cases` : '';
  const term = $('#runTerminal');
  term.style.display = r ? '' : 'none';
  if (r) term.href = fileUrl(`results/${r.id}/terminal.txt`);
}

async function refreshRuns(keepSelection = true) {
  state.runs = await api('/api/runs');
  const wanted = keepSelection && state.run ? state.run.id : readHash().run;
  state.run = state.runs.find((r) => r.id === wanted) || state.runs[0] || null;
  renderRunSelect();
}

const FAST_POLL_MS = 1500;
const IDLE_POLL_MS = 5000;
let pollTimer = null;
let followNewRun = false;

function schedulePoll(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, document.hidden ? Math.max(ms, 15000) : ms);
}

function updateJob(job) {
  const log = $('#jobLog');
  if (job.log !== undefined) {
    log.classList.add('on');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    log.textContent = job.log;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  $('#startRun').disabled = job.running;
  $('#buildPluginsBtn').disabled = job.running;
}

function caseSig(caseId) {
  return JSON.stringify(runVersions().map((v) => [v.spec, caseState(v, caseId), summaryFor(v, caseId)]));
}

// Polls both the UI-started job and results/ itself, so runs started from the CLI show up live too.
async function poll() {
  let active = false;
  try {
    const job = await api('/api/job');
    updateJob(job);
    const prev = state.run;
    const prevLatest = state.runs[0]?.id;
    const prevCaseSig = state.caseId ? caseSig(state.caseId) : '';
    state.runs = await api('/api/runs');
    active = job.running || state.runs.some((r) => isLive(r));

    const newest = state.runs[0];
    // Jump to a newly started run if we were already looking at the latest one (or just started it here).
    if (newest && newest.id !== prevLatest && (followNewRun || !prev || prev.id === prevLatest)) {
      state.run = newest;
      followNewRun = false;
    } else {
      state.run = state.runs.find((r) => r.id === prev?.id) || state.runs[0] || null;
    }
    const switched = state.run?.id !== prev?.id;
    if (switched) state.cache.clear();
    let rendered = false;
    if (switched || JSON.stringify(state.run) !== JSON.stringify(prev)) {
      renderRunSelect();
      renderSidebar();
      writeHash();
      if (!state.caseId) {
        renderOverview();
      } else if (switched || caseSig(state.caseId) !== prevCaseSig) {
        await renderCase({ quiet: !switched });
        rendered = true;
      }
    }
    if (!rendered && state.caseId && state.run && document.querySelector('.live-term, .step.live')) {
      await refreshLiveCase();
    }
  } catch {
    // Server restarting or briefly unreachable; try again on the next tick.
  }
  schedulePoll(active ? FAST_POLL_MS : IDLE_POLL_MS);
}

// While a case is running, re-render only when a step finishes; otherwise just stream the current step's output.
async function refreshLiveCase() {
  const primary = runVersions().find((v) => v.spec === state.version);
  const target = compareTarget();
  const [a, b] = await Promise.all([primary ? loadCaseRecord(primary) : null, target ? loadCaseRecord(target.version, target.run) : null]);
  const records = [a, b].filter(Boolean);
  if (records.map(recordSig).join('|') !== state.shown?.sig) {
    await renderCase({ quiet: true });
    return;
  }
  for (const [slot, r] of [['a', a], ['b', b]]) {
    if (!r) continue;
    const pre = document.querySelector(`.live-term[data-slot="${slot}"]`);
    const text = r.currentStep?.combined;
    if (!pre || !text || pre.textContent === text) continue;
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.textContent = text;
    pre.classList.remove('empty-out');
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }
}

function tickElapsed() {
  document.querySelectorAll('.elapsed[data-since]').forEach((el) => {
    el.textContent = fmtMs(Math.max(0, Date.now() - Date.parse(el.dataset.since)));
  });
}

async function startJob(body) {
  try {
    await api('/api/job', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    followNewRun = !body.plugins;
  } catch (err) {
    alert(err.message);
  }
  schedulePoll(0);
}

// ---------------------------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------------------------
async function init() {
  const [cases, cfg] = await Promise.all([api('/api/cases'), api('/api/config')]);
  state.cases = cases;
  const tags = [...new Set(cases.flatMap((c) => c.tags))].sort();
  $('#tagFilter').innerHTML += tags.map((t) => `<option>${esc(t)}</option>`).join('');
  $('#runForm').elements.versions.placeholder = cfg.versions.join(',') || '0.13.0-SNAPSHOT';
  await refreshRuns(false);
  const h = readHash();
  state.caseId = h.case;
  state.version = h.v;
  state.compare = parseCompare(h.cmp);
  state.view = h.view === 'diff' ? 'diff' : 'side';
  render();

  $('#runSelect').addEventListener('change', (e) => {
    const prevId = state.run?.id;
    state.run = state.runs.find((r) => r.id === e.target.value);
    // A same-run comparison follows the newly selected run; a cross-run one stays pinned to its run.
    if (state.compare?.runId === prevId && state.run?.versions?.some((v) => v.spec === state.compare.spec)) {
      state.compare = { ...state.compare, runId: state.run.id };
    }
    state.cache.clear();
    renderRunSelect();
    render();
  });
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#tagFilter').addEventListener('change', (e) => { state.tag = e.target.value; render(); });
  $('#categoryFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.category = b.dataset.cat;
    document.querySelectorAll('#categoryFilter button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  });
  const pick = (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    state.caseId = row.dataset.id;
    render();
    $('#detail').scrollTop = 0;
  };
  $('#caseList').addEventListener('click', pick);
  $('#detail').addEventListener('click', (e) => {
    if (e.target.closest('.overview tr[data-id], .live-list li[data-id]')) pick(e);
    const vb = e.target.closest('.version-tabs button[data-v]');
    if (vb) {
      state.version = vb.dataset.v;
      if (state.compare?.runId === state.run.id && state.compare.spec === state.version) state.compare = null;
      render();
    }
    const viewBtn = e.target.closest('button[data-view]');
    if (viewBtn) {
      state.view = viewBtn.dataset.view;
      render();
    }
    const modeBtn = e.target.closest('button[data-diffmode]');
    if (modeBtn) {
      state.diffOpts.mode = modeBtn.dataset.diffmode;
      saveDiffOpts();
      renderCase({ quiet: true });
    }
    const unfold = e.target.closest('button[data-unfold]');
    if (unfold) {
      document.getElementById(unfold.dataset.unfold).hidden = false;
      unfold.closest('tbody').remove();
    }
    const streamBtn = e.target.closest('.diff-streams button[data-stream]');
    if (streamBtn) {
      const bar = streamBtn.closest('.diff-streams');
      const pair = state.diffPairs[Number(bar.dataset.pair)];
      state.diffStreams[`${state.caseId}:${(pair.sa || pair.sb).index}`] = streamBtn.dataset.stream;
      const d = streamDiff(pair, streamBtn.dataset.stream);
      bar.nextElementSibling.innerHTML = d.html;
      bar.querySelector('.diff-out-stat').innerHTML = diffStat(d);
      bar.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === streamBtn));
    }
  });
  $('#detail').addEventListener('change', (e) => {
    if (e.target.id === 'compareSelect') {
      state.compare = parseCompare(e.target.value);
      render();
    }
    if (e.target.dataset.opt) {
      state.diffOpts[e.target.dataset.opt] = e.target.checked;
      saveDiffOpts();
      renderCase({ quiet: true });
    }
  });
  // toggle does not bubble, so listen in the capture phase.
  $('#detail').addEventListener('toggle', (e) => {
    if (e.target.matches?.('details.diff-file') && e.target.open) loadFileDiff(e.target);
  }, true);
  document.querySelector('.brand').addEventListener('click', () => { state.caseId = null; render(); });
  document.querySelector('.brand').style.cursor = 'pointer';

  $('#newRunBtn').addEventListener('click', () => { $('#runDialog').showModal(); schedulePoll(0); });
  $('#closeDialog').addEventListener('click', () => $('#runDialog').close());
  $('#runForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    startJob({ versions: f.versions.value.trim(), cases: f.cases.value.trim(), tags: f.tags.value.trim(),
      skipTags: f.skipTags.value.trim(), label: f.label.value.trim(), central: f.central.value });
  });
  $('#buildPluginsBtn').addEventListener('click', () => startJob({ plugins: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(0); });
  setInterval(tickElapsed, 1000);
  schedulePoll(0);
}

init().catch((err) => {
  $('#detail').innerHTML = `<p class="chip exitnz">Failed to load: ${esc(err.message)}</p>`;
});
