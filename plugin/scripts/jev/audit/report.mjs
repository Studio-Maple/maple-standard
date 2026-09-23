/**
 * Report assembly for tools/jev/audit.mjs — turns the per-function results
 * into `.maplelens/audit/report.json` (machine-readable) and a self-contained
 * `report.html` (open it in a browser; no server, no external assets, so it
 * still works after the run that produced it is long gone).
 */

import { computeSeverity, RISKY_SEVERITY_FLOOR } from "./questions.mjs";

/**
 * @param {object} input
 * @param {Array<object>} input.functions   extracted function records, each possibly annotated with .result/.denylisted/.unjudged after auditing
 * @param {Array<object>} input.duplicatePairs  [{aId,bId,jaccard,sameJobProbability}]
 * @param {{mode:string, paths:string[]}} input.runInfo
 * @param {object} input.usageTotals
 * @param {{droppedForCap:number, droppedForDenylist:number}} [input.dupStats]
 */
export function buildReport({ functions, duplicatePairs, exactDuplicateClusters, runInfo, usageTotals, dupStats, denylistedFiles }) {
  const byModule = new Map();
  const ranked = [];

  for (const fn of functions) {
    const severity =
      fn.denylisted || fn.unjudged
        ? null
        : computeSeverity(fn.scores, fn.confidences, { deliberateBestEffort: fn.deliberateBestEffort, lineCount: fn.lineCount });
    fn.severity = severity;

    const mod = fn.module ?? "other";
    if (!byModule.has(mod)) byModule.set(mod, { module: mod, count: 0, audited: 0, severitySum: 0, worst: null });
    const bucket = byModule.get(mod);
    bucket.count++;
    if (severity !== null) {
      bucket.audited++;
      bucket.severitySum += severity;
      if (!bucket.worst || severity > bucket.worst.severity) bucket.worst = { id: fn.id, severity };
    }

    if (!fn.denylisted) ranked.push(fn);
  }

  const moduleHeatmap = [...byModule.values()]
    .map((b) => ({ ...b, avgSeverity: b.audited ? b.severitySum / b.audited : null }))
    .sort((a, b) => (b.avgSeverity ?? -1) - (a.avgSeverity ?? -1));

  // Worst-first: unjudged sorts after every scored function (see the formula
  // doc in audit-questions.mjs — null must never look "clean").
  const worstFirst = [...ranked].sort((a, b) => {
    if (a.severity === null && b.severity === null) return 0;
    if (a.severity === null) return 1;
    if (b.severity === null) return -1;
    return b.severity - a.severity;
  });

  const untestedRisky = ranked.filter(
    (fn) => fn.severity !== null && fn.severity >= RISKY_SEVERITY_FLOOR && !fn.hasTestReference,
  );

  const notAudited = functions.filter((fn) => fn.denylisted);

  // error_handling flagged: Jev judged the function's own error handling as
  // more likely bad than good (P(good) < 0.5). Split by whether the
  // deterministic pre-check (`hasDeliberateBestEffortCatch`, audit-extract.mjs)
  // found a documented best-effort swallow — those get no severity penalty
  // for it (see computeSeverity's `deliberateBestEffort` option) but are
  // still counted and listed here so the exemption stays visible.
  const errorHandlingFlagged = ranked.filter((fn) => !fn.unjudged && fn.scores && fn.scores.error_handling < 0.5 && (fn.scores.can_fail ?? 1) >= 0.5);
  const errorHandlingReal = errorHandlingFlagged.filter((fn) => !fn.deliberateBestEffort);
  const errorHandlingDeliberate = errorHandlingFlagged.filter((fn) => fn.deliberateBestEffort);

  return {
    generatedAt: new Date().toISOString(),
    runInfo,
    totals: {
      extracted: functions.length,
      audited: ranked.filter((f) => !f.unjudged).length,
      unjudged: ranked.filter((f) => f.unjudged).length,
      denylisted: notAudited.length,
      cacheHits: functions.filter((f) => f.fromCache).length,
    },
    usage: usageTotals,
    duplicatePairs,
    exactDuplicateClusters: exactDuplicateClusters ?? [],
    dupStats: dupStats ?? { droppedForCap: 0, droppedForDenylist: 0 },
    denylistedFiles: denylistedFiles ?? [],
    moduleHeatmap,
    worstFirst: worstFirst.map(stripSourceForReport),
    untestedRisky: untestedRisky.map(toIdSeverityScores),
    errorHandling: {
      flagged: errorHandlingFlagged.length,
      real: errorHandlingReal.length,
      deliberateBestEffort: errorHandlingDeliberate.length,
    },
    deliberateBestEffort: errorHandlingDeliberate.map(toIdSeverityScores),
    notAudited: notAudited.map((f) => f.id),
  };
}

/** Shrink a function record to the {id, severity, scores} shape used by list-y report sections (untestedRisky, deliberateBestEffort) — same information worstFirst carries, without the rest of the fields. */
function toIdSeverityScores(fn) {
  return { id: fn.id, severity: fn.severity, scores: fn.scores };
}

/** report.json/html carry scores and metadata, never the raw source (keeps the artifact small and avoids re-publishing code verbatim outside the repo). */
function stripSourceForReport(fn) {
  const { source, imports, ...rest } = fn;
  return rest;
}

export function renderHtmlReport(report) {
  const json = JSON.stringify(report).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MapleLens Jev audit report</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 2rem; max-width: 1100px; margin-inline: auto; }
  h1 { margin-bottom: 0.2rem; }
  .meta { color: #888; font-size: 0.9rem; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; font-size: 0.88rem; }
  th, td { border-bottom: 1px solid #8883; padding: 0.35rem 0.6rem; text-align: left; }
  th { cursor: default; }
  tr:hover td { background: #8881; }
  .sev-high { color: #c0392b; font-weight: 600; }
  .sev-mid { color: #d68910; }
  .sev-low { color: #27ae60; }
  .pill { display: inline-block; padding: 0 0.4rem; border-radius: 0.6rem; background: #8882; font-size: 0.78rem; }
  code { font-size: 0.85em; }
  section { margin-bottom: 2.5rem; }
  .heat { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .heat-tile { padding: 0.6rem 1rem; border-radius: 0.4rem; min-width: 7rem; }
  details summary { cursor: pointer; }
</style>
</head>
<body>
<h1>MapleLens — Jev per-function audit</h1>
<div class="meta" id="meta"></div>

<section>
  <h2>Module heatmap</h2>
  <div class="heat" id="heatmap"></div>
</section>

<section>
  <h2>Worst-first (top 200 shown)</h2>
  <table id="worst"><thead><tr>
    <th>Severity</th><th>Function</th><th>File</th><th>Security</th><th>Efficiency</th><th>Clarity</th>
    <th>Errors handled</th><th>Edge cases</th><th>Tested</th>
  </tr></thead><tbody></tbody></table>
</section>

<section>
  <h2>Untested and risky</h2>
  <table id="risky"><thead><tr><th>Function</th><th>Severity</th></tr></thead><tbody></tbody></table>
</section>

<section>
  <h2>Error handling — flagged vs. deliberate best-effort</h2>
  <div class="meta" id="errmeta"></div>
  <table id="deliberate"><thead><tr><th>Function</th><th>Severity</th></tr></thead><tbody></tbody></table>
</section>

<section>
  <h2>Exact-duplicate clusters (deterministic, no Jev call)</h2>
  <table id="exactdups"><thead><tr><th>Members</th><th>Count</th></tr></thead><tbody></tbody></table>
</section>

<section>
  <h2>Near-duplicate pairs (Jev-confirmed)</h2>
  <table id="dups"><thead><tr><th>Jaccard</th><th>Same job? (Jev)</th><th>A</th><th>B</th></tr></thead><tbody></tbody></table>
</section>

<section>
  <h2>Not audited (sensitive)</h2>
  <table id="notaudited"><thead><tr><th>Function</th></tr></thead><tbody></tbody></table>
</section>

<script id="report-data" type="application/json">${json}</script>
<script>
(function () {
  const report = JSON.parse(document.getElementById('report-data').textContent);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const sevClass = (s) => s === null || s === undefined ? '' : s >= 7 ? 'sev-high' : s >= 4 ? 'sev-mid' : 'sev-low';
  const fmt = (n) => n === null || n === undefined ? '—' : (Math.round(n * 100) / 100).toString();

  document.getElementById('meta').textContent =
    'Generated ' + report.generatedAt + ' — mode: ' + report.runInfo.mode +
    ' — extracted ' + report.totals.extracted + ', audited ' + report.totals.audited +
    ', unjudged ' + report.totals.unjudged + ', denylisted ' + report.totals.denylisted +
    ', cache hits ' + report.totals.cacheHits +
    (report.usage && report.usage.calls ? ' — Jev calls: ' + report.usage.calls : '');

  const heat = document.getElementById('heatmap');
  for (const m of report.moduleHeatmap) {
    const div = document.createElement('div');
    div.className = 'heat-tile';
    const sev = m.avgSeverity;
    div.style.background = sev === null ? '#8882' : sev >= 7 ? '#c0392b33' : sev >= 4 ? '#d68910' + '33' : '#27ae6033';
    div.innerHTML = '<strong>' + esc(m.module) + '</strong><br>' + m.count + ' fns<br>avg sev ' + fmt(sev);
    heat.appendChild(div);
  }

  const worstBody = document.querySelector('#worst tbody');
  for (const fn of report.worstFirst.slice(0, 200)) {
    const tr = document.createElement('tr');
    const s = fn.scores || {};
    tr.innerHTML =
      '<td class="' + sevClass(fn.severity) + '">' + (fn.unjudged ? 'unjudged' : fmt(fn.severity)) + '</td>' +
      '<td><code>' + esc(fn.qualifiedName) + '</code></td>' +
      '<td>' + esc(fn.file) + ':' + fn.startLine + '</td>' +
      '<td>' + fmt(s.security) + '</td>' +
      '<td>' + fmt(s.efficiency) + '</td>' +
      '<td>' + fmt(s.clarity) + '</td>' +
      '<td>' + fmt(s.error_handling) + '</td>' +
      '<td>' + fmt(s.edge_cases) + '</td>' +
      '<td>' + (fn.hasTestReference ? 'yes' : 'no') + '</td>';
    worstBody.appendChild(tr);
  }

  const riskyBody = document.querySelector('#risky tbody');
  for (const f of report.untestedRisky) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><code>' + esc(f.id) + '</code></td><td>' + fmt(f.severity) + '</td>';
    riskyBody.appendChild(tr);
  }

  if (report.errorHandling) {
    document.getElementById('errmeta').textContent =
      'flagged ' + report.errorHandling.flagged + ' — real ' + report.errorHandling.real +
      ', deliberate best-effort (exempted) ' + report.errorHandling.deliberateBestEffort;
  }
  const deliberateBody = document.querySelector('#deliberate tbody');
  for (const f of report.deliberateBestEffort || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><code>' + esc(f.id) + '</code></td><td>' + fmt(f.severity) + '</td>';
    deliberateBody.appendChild(tr);
  }

  const exactDupBody = document.querySelector('#exactdups tbody');
  for (const c of report.exactDuplicateClusters || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + c.memberIds.map(id => '<code>' + esc(id) + '</code>').join('<br>') + '</td><td>' + c.memberIds.length + '</td>';
    exactDupBody.appendChild(tr);
  }

  const dupBody = document.querySelector('#dups tbody');
  for (const p of report.duplicatePairs) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + fmt(p.jaccard) + '</td>' +
      '<td>' + (p.sameJobProbability === undefined || p.sameJobProbability === null ? '—' : fmt(p.sameJobProbability)) + '</td>' +
      '<td><code>' + esc(p.aId) + '</code></td>' +
      '<td><code>' + esc(p.bId) + '</code></td>';
    dupBody.appendChild(tr);
  }

  const naBody = document.querySelector('#notaudited tbody');
  for (const id of report.notAudited) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><code>' + esc(id) + '</code></td>';
    naBody.appendChild(tr);
  }
})();
</script>
</body>
</html>
`;
}
