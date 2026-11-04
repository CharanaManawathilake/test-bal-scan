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
  compareWith: null,
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

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return { run: params.get('run'), case: params.get('case'), v: params.get('v'), cmp: params.get('cmp') };
}

function writeHash() {
  const params = new URLSearchParams();
  if (state.run) params.set('run', state.run.id);
  if (state.caseId) params.set('case', state.caseId);
  if (state.version) params.set('v', state.version);
  if (state.compareWith) params.set('cmp', state.compareWith);
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
function caseState(version, caseId) {
  if (summaryFor(version, caseId)) return 'done';
  if (!isLive()) return 'none';
  if (version.running?.includes(caseId)) return 'running';
  const inRun = state.run.caseIds ? state.run.caseIds.includes(caseId) : true;
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
async function loadCaseRecord(version) {
  const def = state.cases.find((c) => c.id === state.caseId);
  const live = caseState(version, def.id);
  if (live === 'pending' || !version.dir) {
    return { version: version.spec, pending: true };
  }
  const key = `${state.run.id}|${version.dir}|${def.id}`;
  if (!state.cache.has(key)) {
    const p = api(`/api/runs/${encodeURIComponent(state.run.id)}/${encodeURIComponent(version.dir)}/${def.category}/${def.name}`)
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

function stepHtml(step, record, otherStep) {
  const isDiff = otherStep && (otherStep.exitCode !== step.exitCode
    || (otherStep.observations?.stdoutIssues?.total ?? null) !== (step.observations?.stdoutIssues?.total ?? null));
  const id = `${record.version}-${step.index}`;
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

function liveStepHtml(record) {
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
    <pre class="term live-term ${s.combined ? '' : 'empty-out'}" data-ver="${esc(record.version)}">${esc(s.combined || '(no output yet)')}</pre>
  </div>`;
}

function recordColumn(record, other) {
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
    ? (isLive() ? `<p class="muted">Running: step ${record.currentStep?.index ?? record.steps.length} of ${record.stepCount ?? '?'}. Completed steps appear as they finish.</p>`
      : '<p class="chip exitnz">This case never finished (the run was interrupted).</p>')
    : '';
  const steps = record.steps.map((s) => stepHtml(s, record, other?.steps?.find((o) => o.index === s.index))).join('');
  return banner + links + steps + (running && isLive() ? liveStepHtml(record) : '');
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
  const tabs = `<div class="version-tabs">${versions.map((v) => `<button data-v="${esc(v.spec)}" class="${v.spec === state.version ? 'on' : ''}">${esc(v.spec)}</button>`).join('')}
    ${versions.length > 1 ? `<label class="compare-toggle">compare with <select id="compareSelect"><option value="">-</option>
      ${versions.filter((v) => v.spec !== state.version).map((v) => `<option ${v.spec === state.compareWith ? 'selected' : ''}>${esc(v.spec)}</option>`).join('')}</select></label>` : ''}</div>`;
  if (!quiet) {
    $('#detail').innerHTML = `${head}${tabs}<div id="caseBody" class="muted">Loading...</div>`;
  }

  const primary = versions.find((v) => v.spec === state.version);
  const secondary = versions.find((v) => v.spec === state.compareWith && v.spec !== state.version);
  if (!primary) {
    $('#detail').innerHTML = `${head}${tabs}<div id="caseBody" class="muted">This run has no usable versions.</div>`;
    return;
  }
  const [a, b] = await Promise.all([loadCaseRecord(primary), secondary ? loadCaseRecord(secondary) : null]);
  if (token !== renderSeq) return;
  const body = secondary
    ? `<div class="columns two"><div><div class="col-title">${esc(primary.spec)}</div>${recordColumn(a, b)}</div>
       <div><div class="col-title">${esc(secondary.spec)}</div>${recordColumn(b, a)}</div></div>`
    : `<div class="columns">${recordColumn(a)}</div>`;
  const scroll = $('#detail').scrollTop;
  $('#detail').innerHTML = `${head}${tabs}<div id="caseBody">${body}</div>`;
  $('#detail').scrollTop = scroll;
  document.querySelectorAll('.live-term').forEach((pre) => { pre.scrollTop = pre.scrollHeight; });
  tickElapsed();
  const records = [a, b].filter(Boolean);
  state.shown = { caseId: def.id, runId: state.run.id, sig: records.map(recordSig).join('|') };
  document.querySelectorAll('.term-tabs').forEach((tabsEl) => {
    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const [ver, idx] = [tabsEl.dataset.step.slice(0, tabsEl.dataset.step.lastIndexOf('-')), Number(tabsEl.dataset.step.split('-').pop())];
      const rec = records.find((r) => r.version === ver);
      const step = rec?.steps.find((s) => s.index === idx);
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
  const versions = runVersions();
  const shown = [state.version, state.compareWith].map((s) => versions.find((v) => v.spec === s)).filter(Boolean);
  const records = await Promise.all(shown.map(loadCaseRecord));
  if (records.map(recordSig).join('|') !== state.shown?.sig) {
    await renderCase({ quiet: true });
    return;
  }
  for (const r of records) {
    const pre = document.querySelector(`.live-term[data-ver="${CSS.escape(r.version)}"]`);
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
  state.compareWith = h.cmp;
  render();

  $('#runSelect').addEventListener('change', (e) => {
    state.run = state.runs.find((r) => r.id === e.target.value);
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
      if (state.compareWith === state.version) state.compareWith = null;
      render();
    }
  });
  $('#detail').addEventListener('change', (e) => {
    if (e.target.id === 'compareSelect') {
      state.compareWith = e.target.value || null;
      render();
    }
  });
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
