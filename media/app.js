/* Pulse dashboard app */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const { fmtDur, esc, tipRows, bindTip } = window.Charts;
  const $app = document.getElementById('app');

  const saved = vscode.getState() || {};
  const state = {
    days: [],
    live: null,
    loaded: false,
    range: saved.range || '7d',
    project: saved.project || 'all',
    tab: saved.tab || 'overview',
    theme: saved.theme || 'system',
    breakdown: saved.breakdown || 'language',
    fileSort: saved.fileSort || { key: 'ms', dir: -1 },
    fileQuery: '',
    sessionDay: null
  };
  const persist = () => vscode.setState({
    range: state.range, project: state.project, tab: state.tab, theme: state.theme,
    breakdown: state.breakdown, fileSort: state.fileSort
  });

  // ------------------------------------------------------------------ theme
  function applyTheme() {
    let t = state.theme;
    if (t === 'system') {
      const c = document.body.classList;
      t = c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', t);
  }
  new MutationObserver(() => { if (state.theme === 'system') applyTheme(); })
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  applyTheme();

  // ------------------------------------------------------------------ helpers
  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const todayKey = () => keyOf(new Date());
  const num = n => (n || 0).toLocaleString();
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const shortDate = k => parseKey(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const longDate = k => parseKey(k).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const timeOf = ts => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const LANG_NAMES = {
    javascript: 'JavaScript', typescript: 'TypeScript', javascriptreact: 'JavaScript React', typescriptreact: 'TypeScript React',
    python: 'Python', java: 'Java', csharp: 'C#', cpp: 'C++', c: 'C', go: 'Go', rust: 'Rust', ruby: 'Ruby', php: 'PHP',
    swift: 'Swift', kotlin: 'Kotlin', dart: 'Dart', html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less', json: 'JSON',
    jsonc: 'JSON with Comments', markdown: 'Markdown', yaml: 'YAML', xml: 'XML', sql: 'SQL', shellscript: 'Shell',
    powershell: 'PowerShell', dockerfile: 'Dockerfile', vue: 'Vue', svelte: 'Svelte', plaintext: 'Plain Text',
    terminal: 'Terminal', lua: 'Lua', r: 'R', scala: 'Scala', elixir: 'Elixir', haskell: 'Haskell', toml: 'TOML',
    ini: 'INI', makefile: 'Makefile', graphql: 'GraphQL', prisma: 'Prisma', astro: 'Astro', 'objective-c': 'Objective-C',
    ignore: 'Ignore', properties: 'Properties', bat: 'Batch', perl: 'Perl', clojure: 'Clojure', fsharp: 'F#', zig: 'Zig'
  };
  const langName = id => LANG_NAMES[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Unknown');

  const CATS = [
    { key: 'coding', name: 'Coding', icon: 'ri-code-s-slash-line', color: 'var(--c-coding)', desc: 'Typing & editing' },
    { key: 'reading', name: 'Reading', icon: 'ri-book-open-line', color: 'var(--c-reading)', desc: 'Navigating, scrolling, reviewing' },
    { key: 'debugging', name: 'Debugging', icon: 'ri-bug-line', color: 'var(--c-debugging)', desc: 'Active debug sessions' },
    { key: 'terminal', name: 'Terminal', icon: 'ri-terminal-box-line', color: 'var(--c-terminal)', desc: 'Running commands' }
  ];

  const SLOT_COUNT = 7; // slot 8 is kept free; everything past 7 folds into "Other"
  /** Stable colour per entity, based on all-time rank — filters never repaint survivors. */
  function colorMaps() {
    const lang = {}, proj = {};
    for (const day of state.days) {
      for (const [pn, p] of Object.entries(day.projects)) {
        proj[pn] = (proj[pn] || 0) + p.ms;
        for (const [l, s] of Object.entries(p.languages)) lang[l] = (lang[l] || 0) + s.ms;
      }
    }
    const toMap = obj => {
      const m = {};
      Object.entries(obj).sort((a, b) => b[1] - a[1]).forEach(([k], i) => { m[k] = i < SLOT_COUNT ? `var(--s${i + 1})` : 'var(--other)'; });
      return m;
    };
    return { lang: toMap(lang), proj: toMap(proj) };
  }
  let colors = { lang: {}, proj: {} };
  const langColor = l => colors.lang[l] || 'var(--other)';
  const projColor = p => colors.proj[p] || 'var(--other)';

  // ------------------------------------------------------------------ ranges
  const RANGES = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: '7d', label: '7D' },
    { key: '30d', label: '30D' },
    { key: '90d', label: '90D' },
    { key: 'year', label: '1Y' },
    { key: 'all', label: 'All' }
  ];
  function rangeBounds(key) {
    const t = todayKey();
    const first = state.days.length ? state.days[0].date : t;
    switch (key) {
      case 'today': return { from: t, to: t, label: 'Today' };
      case 'yesterday': { const y = addDays(t, -1); return { from: y, to: y, label: 'Yesterday' }; }
      case '7d': return { from: addDays(t, -6), to: t, label: 'last 7 days' };
      case '30d': return { from: addDays(t, -29), to: t, label: 'last 30 days' };
      case '90d': return { from: addDays(t, -89), to: t, label: 'last 90 days' };
      case 'year': return { from: addDays(t, -364), to: t, label: 'last 12 months' };
      default: return { from: first < t ? first : t, to: t, label: 'all time' };
    }
  }
  function dayCount(from, to) { return Math.round((parseKey(to) - parseKey(from)) / 86400000) + 1; }
  function previousBounds(b) {
    if (state.range === 'all') return null;
    const n = dayCount(b.from, b.to);
    return { from: addDays(b.from, -n), to: addDays(b.from, -1) };
  }
  function datesBetween(from, to) {
    const out = [];
    for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
    return out;
  }

  // ------------------------------------------------------------------ aggregation
  function aggregate(from, to, project) {
    const A = {
      total: 0, perDay: {}, languages: {}, files: {}, projects: {}, branches: {}, categories: {},
      hours: new Array(24).fill(0), hourCats: Array.from({ length: 24 }, () => ({})), wdh: Array.from({ length: 7 }, () => new Array(24).fill(0)),
      counters: {}, sessions: [], activeDays: 0, buckets: new Array(288).fill(0)
    };
    for (const day of state.days) {
      if (day.date < from || day.date > to) continue;
      const pd = { ms: 0, langs: {}, cats: {}, projs: {} };
      const wd = (parseKey(day.date).getDay() + 6) % 7;
      for (const [pn, p] of Object.entries(day.projects)) {
        if (project !== 'all' && pn !== project) continue;
        A.total += p.ms; pd.ms += p.ms; pd.projs[pn] = (pd.projs[pn] || 0) + p.ms;
        p.hours.forEach((v, h) => { A.hours[h] += v; A.wdh[wd][h] += v; });
        p.buckets.forEach((v, i) => { A.buckets[i] += v; });
        const catShare = p.ms ? p.categories : {};
        for (const [c, v] of Object.entries(catShare)) { A.categories[c] = (A.categories[c] || 0) + v; pd.cats[c] = (pd.cats[c] || 0) + v; }
        // Approximate hour-by-category by distributing each hour by the project's daily category mix.
        p.hours.forEach((v, h) => {
          if (!v || !p.ms) return;
          for (const [c, cv] of Object.entries(p.categories)) A.hourCats[h][c] = (A.hourCats[h][c] || 0) + v * (cv / p.ms);
        });
        for (const [b, v] of Object.entries(p.branches)) { const k = `${pn} · ${b}`; A.branches[k] = (A.branches[k] || 0) + v; }
        for (const [l, s] of Object.entries(p.languages)) {
          const L = A.languages[l] || (A.languages[l] = { ms: 0, edits: 0, linesAdded: 0, linesDeleted: 0, charsAdded: 0, charsDeleted: 0, files: new Set() });
          for (const k of ['ms', 'edits', 'linesAdded', 'linesDeleted', 'charsAdded', 'charsDeleted']) L[k] += s[k] || 0;
          pd.langs[l] = (pd.langs[l] || 0) + (s.ms || 0);
        }
        for (const [path, f] of Object.entries(p.files)) {
          const key = pn + '\u0000' + path;
          const F = A.files[key] || (A.files[key] = { project: pn, path, language: f.language, ms: 0, edits: 0, linesAdded: 0, linesDeleted: 0, charsAdded: 0, saves: 0, opens: 0, days: 0, last: day.date });
          for (const k of ['ms', 'edits', 'linesAdded', 'linesDeleted', 'charsAdded', 'saves', 'opens']) F[k] += f[k] || 0;
          F.days += 1; if (day.date > F.last) F.last = day.date;
          if (f.language && A.languages[f.language]) A.languages[f.language].files.add(key);
        }
        const P = A.projects[pn] || (A.projects[pn] = { ms: 0, edits: 0, linesAdded: 0, linesDeleted: 0, commits: 0, files: 0, langs: {}, days: 0, last: day.date });
        P.ms += p.ms; P.edits += p.counters.edits || 0; P.linesAdded += p.counters.linesAdded || 0; P.linesDeleted += p.counters.linesDeleted || 0;
        P.commits += p.counters.commits || 0; P.files += Object.keys(p.files).length; P.days += 1; if (day.date > P.last) P.last = day.date;
        for (const [l, s] of Object.entries(p.languages)) P.langs[l] = (P.langs[l] || 0) + s.ms;
        for (const [k, v] of Object.entries(p.counters)) A.counters[k] = (A.counters[k] || 0) + v;
      }
      for (const s of day.sessions || []) {
        if (project !== 'all' && !(s.projects && s.projects[project])) continue;
        A.sessions.push(Object.assign({ date: day.date }, s));
      }
      if (pd.ms > 0) A.activeDays += 1;
      A.perDay[day.date] = pd;
    }
    A.sessions.sort((a, b) => b.start - a.start);
    return A;
  }

  function streak(project) {
    const active = new Set();
    for (const day of state.days) {
      for (const [pn, p] of Object.entries(day.projects)) {
        if ((project === 'all' || pn === project) && p.ms > 60000) active.add(day.date);
      }
    }
    let k = todayKey();
    if (!active.has(k)) k = addDays(k, -1);
    let n = 0;
    while (active.has(k)) { n++; k = addDays(k, -1); }
    let best = 0, cur = 0, prev = null;
    for (const d of [...active].sort()) { cur = prev && addDays(prev, 1) === d ? cur + 1 : 1; best = Math.max(best, cur); prev = d; }
    return { current: n, best };
  }

  // ------------------------------------------------------------------ UI pieces
  const icon = (name, extra = '') => `<i class="${name}" aria-hidden="true"${extra}></i>`;

  function card(title, desc, body, opts = {}) {
    return `<div class="card ${opts.cls || ''}">
      <div class="card-header"><div><h3 class="card-title">${title}</h3>${desc ? `<p class="card-desc">${desc}</p>` : ''}</div>${opts.action || ''}</div>
      <div class="card-content">${body}</div>${opts.footer ? `<div class="card-footer">${opts.footer}</div>` : ''}
    </div>`;
  }

  function kpi(label, iconName, value, sub, extra = '') {
    return `<div class="card kpi-card"><div class="card-content">
      <div class="kpi-label"><span>${label}</span>${icon(iconName)}</div>
      <div class="kpi-value">${value}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}${extra}
    </div></div>`;
  }

  function empty(text, iconName = 'ri-time-line') {
    return `<div class="empty">${icon(iconName)}${text}</div>`;
  }

  function barList(items, opts = {}) {
    if (!items.length) return empty(opts.emptyText || 'No data for this period');
    const max = Math.max(...items.map(i => i.value), 1);
    const total = opts.total || items.reduce((s, i) => s + i.value, 0);
    return `<div class="bar-list">${items.map((it, idx) => `
      <div class="bar-row ${opts.onClick ? 'clickable' : ''}" data-idx="${idx}" ${it.title ? `title="${esc(it.title)}"` : ''}>
        <div class="fill" style="width:${(it.value / max) * 100}%"></div>
        <div class="label">${it.color ? `<span class="swatch" style="background:${it.color}"></span>` : ''}${it.iconHtml || ''}<span class="text">${it.labelHtml || esc(it.label)}</span></div>
        <div class="value">${opts.fmt ? opts.fmt(it.value) : fmtDur(it.value)}${opts.showPct !== false ? `<span class="pct">${pct(it.value, total)}%</span>` : ''}</div>
      </div>`).join('')}</div>`;
  }

  function fileLabel(path) {
    const i = path.lastIndexOf('/');
    if (i < 0) return `<strong>${esc(path)}</strong>`;
    return `<span class="dir">${esc(path.slice(0, i + 1))}</span><strong>${esc(path.slice(i + 1))}</strong>`;
  }

  function deltaHtml(cur, prev, label) {
    if (prev == null) return '';
    if (!prev) return cur ? `<span class="delta-up">${icon('ri-arrow-up-line')}new</span> vs ${label}` : `no activity in ${label}`;
    const d = Math.round(((cur - prev) / prev) * 100);
    const cls = d >= 0 ? 'delta-up' : 'delta-down';
    return `<span class="${cls}">${icon(d >= 0 ? 'ri-arrow-up-line' : 'ri-arrow-down-line')}${Math.abs(d)}%</span> vs ${label}`;
  }

  // ------------------------------------------------------------------ render: shell
  function render() {
    if (!state.loaded) return;
    colors = colorMaps();
    const active = document.activeElement;
    const refocusSearch = active && active.id === 'file-search' ? active.selectionStart : null;

    const projects = new Set();
    state.days.forEach(d => Object.keys(d.projects).forEach(p => projects.add(p)));
    if (state.project !== 'all' && !projects.has(state.project)) state.project = 'all';

    const b = rangeBounds(state.range);
    const A = aggregate(b.from, b.to, state.project);
    const pb = previousBounds(b);
    const P = pb ? aggregate(pb.from, pb.to, state.project) : null;
    const rangeText = b.from === b.to ? longDate(b.from) : `${shortDate(b.from)} – ${shortDate(b.to)}, ${parseKey(b.to).getFullYear()}`;

    const tabs = [
      { key: 'overview', label: 'Overview', icon: 'ri-dashboard-line' },
      { key: 'languages', label: 'Languages', icon: 'ri-code-box-line' },
      { key: 'files', label: 'Files', icon: 'ri-file-list-3-line' },
      { key: 'projects', label: 'Projects', icon: 'ri-folders-line' },
      { key: 'activity', label: 'Activity', icon: 'ri-calendar-2-line' },
      { key: 'sessions', label: 'Sessions', icon: 'ri-timer-line' }
    ];

    $app.innerHTML = `<div class="container">
      <header class="header">
        <div class="brand">
          <div class="brand-mark">${icon('ri-pulse-line')}</div>
          <div><h1>Pulse</h1><p>Your coding activity, tracked automatically</p></div>
          <span id="live-badge">${liveBadge()}</span>
        </div>
        <div class="toolbar">
          <div class="seg" role="radiogroup" aria-label="Theme">
            ${[['system', 'ri-computer-line', 'System'], ['light', 'ri-sun-line', 'Light'], ['dark', 'ri-moon-line', 'Dark']].map(([k, ic, n]) =>
              `<button data-theme-choice="${k}" class="${state.theme === k ? 'active' : ''}" title="${n} theme" aria-label="${n} theme" role="radio" aria-checked="${state.theme === k}">${icon(ic)}</button>`).join('')}
          </div>
          <button class="btn" id="btn-pause">${state.live && state.live.state === 'paused' ? icon('ri-play-line') + 'Resume' : icon('ri-pause-line') + 'Pause'}</button>
          <button class="btn icon" id="btn-refresh" title="Refresh">${icon('ri-refresh-line')}</button>
          <button class="btn icon" data-cmd="pulse.exportCsv" title="Export files report (CSV)">${icon('ri-file-excel-2-line')}</button>
          <button class="btn icon" data-cmd="pulse.exportJson" title="Export all data (JSON)">${icon('ri-download-2-line')}</button>
          <button class="btn icon" id="btn-settings" title="Settings">${icon('ri-settings-3-line')}</button>
        </div>
      </header>

      <div class="section-head">
        <div class="toolbar">
          <div class="seg" role="radiogroup" aria-label="Date range">
            ${RANGES.map(r => `<button data-range="${r.key}" class="${state.range === r.key ? 'active' : ''}" role="radio" aria-checked="${state.range === r.key}">${r.label}</button>`).join('')}
          </div>
          <select class="select" id="project-select" aria-label="Project">
            <option value="all">All projects</option>
            ${[...projects].sort().map(p => `<option value="${esc(p)}" ${state.project === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
          </select>
        </div>
        <span class="muted" style="font-size:13px">${icon('ri-calendar-line')} ${rangeText}</span>
      </div>

      <nav class="tabs" role="tablist">
        ${tabs.map(t => `<button class="tab ${state.tab === t.key ? 'active' : ''}" data-tab="${t.key}" role="tab" aria-selected="${state.tab === t.key}">${icon(t.icon)}${t.label}</button>`).join('')}
      </nav>

      <main id="tab-body">${renderTab(A, P, b)}</main>
    </div>`;

    bindShell();
    mountTab(A, P, b);

    if (refocusSearch !== null) {
      const el = document.getElementById('file-search');
      if (el) { el.focus(); el.setSelectionRange(refocusSearch, refocusSearch); }
    }
  }

  function liveBadge() {
    const l = state.live;
    if (!l) return '';
    if (l.state === 'active') return `<span class="badge active" title="Activity detected — time is being recorded"><span class="dot"></span>Tracking</span>`;
    if (l.state === 'paused') return `<span class="badge paused" title="Tracking paused">${icon('ri-pause-circle-line')}Paused</span>`;
    return `<span class="badge" title="No activity for ${l.idleMinutes}+ min. Resumes automatically when you type."><span class="dot"></span>Idle · resumes on typing</span>`;
  }

  function bindShell() {
    $app.querySelectorAll('[data-range]').forEach(el => el.addEventListener('click', () => { state.range = el.dataset.range; state.sessionDay = null; persist(); render(); }));
    $app.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => { state.tab = el.dataset.tab; persist(); render(); }));
    $app.querySelectorAll('[data-theme-choice]').forEach(el => el.addEventListener('click', () => { state.theme = el.dataset.themeChoice; persist(); applyTheme(); render(); }));
    $app.querySelectorAll('[data-cmd]').forEach(el => el.addEventListener('click', () => vscode.postMessage({ type: 'command', command: el.dataset.cmd })));
    document.getElementById('project-select').addEventListener('change', e => { state.project = e.target.value; persist(); render(); });
    document.getElementById('btn-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('btn-pause').addEventListener('click', () => vscode.postMessage({ type: 'togglePause' }));
    document.getElementById('btn-settings').addEventListener('click', () => vscode.postMessage({ type: 'settings' }));
  }

  // ------------------------------------------------------------------ tabs
  function renderTab(A, P, b) {
    if (!state.days.length) {
      return card('No activity yet', 'Start typing in any file and Pulse will begin tracking automatically.',
        empty('Your dashboard will fill up as you work. Idle time (no activity for the configured timeout) is never counted.', 'ri-keyboard-line'));
    }
    switch (state.tab) {
      case 'languages': return tabLanguages(A);
      case 'files': return tabFiles(A);
      case 'projects': return tabProjects(A, b);
      case 'activity': return tabActivity(A, b);
      case 'sessions': return tabSessions(A, b);
      default: return tabOverview(A, P, b);
    }
  }

  function mountTab(A, P, b) {
    if (!state.days.length) return;
    const mounts = {
      overview: mountOverview, languages: mountLanguages, files: mountFiles,
      projects: mountProjects, activity: mountActivity, sessions: mountSessions
    };
    (mounts[state.tab] || mountOverview)(A, P, b);
  }

  // ---------------- overview
  function tabOverview(A, P, b) {
    const n = dayCount(b.from, b.to);
    const prevLabel = state.range === 'today' ? 'yesterday' : state.range === 'yesterday' ? 'day before' : `previous ${n} days`;
    const avg = A.activeDays ? A.total / A.activeDays : 0;
    const live = state.live || {};
    const todayAgg = state.project === 'all' && live.todayMs != null ? live.todayMs : aggregate(todayKey(), todayKey(), state.project).total;
    const goal = live.goalMs || 0;
    const sess = A.sessions;
    const longest = sess.reduce((m, s) => Math.max(m, s.ms), 0);
    const avgSess = sess.length ? sess.reduce((s, x) => s + x.ms, 0) / sess.length : 0;
    const langs = Object.entries(A.languages).sort((a, b2) => b2[1].ms - a[1].ms);
    const topLang = langs[0];
    const peakHour = A.hours.indexOf(Math.max(...A.hours));
    const st = streak(state.project);
    const c = A.counters;

    const single = b.from === b.to;
    const breakdownToggle = single ? '' : `<div class="seg" role="radiogroup" aria-label="Breakdown">
        <button data-breakdown="language" class="${state.breakdown === 'language' ? 'active' : ''}">Languages</button>
        <button data-breakdown="category" class="${state.breakdown === 'category' ? 'active' : ''}">Activity</button>
        <button data-breakdown="project" class="${state.breakdown === 'project' ? 'active' : ''}">Projects</button></div>`;

    return `
      <div class="grid kpi">
        ${kpi('Total time', 'ri-time-line', fmtDur(A.total), deltaHtml(A.total, P && P.total, prevLabel))}
        ${kpi('Daily average', 'ri-bar-chart-line', fmtDur(avg), `${A.activeDays} active ${A.activeDays === 1 ? 'day' : 'days'} of ${n}`)}
        ${kpi("Today's goal", 'ri-focus-3-line', `${fmtDur(todayAgg)}<span class="muted" style="font-size:14px;font-weight:500"> / ${goal ? fmtDur(goal) : '—'}</span>`,
          goal ? `${pct(todayAgg, goal)}% complete${todayAgg >= goal ? ' · ' + icon('ri-check-line') + ' reached' : ''}` : 'Set pulse.dailyGoalHours',
          goal ? `<div class="progress"><div style="width:${Math.min(100, pct(todayAgg, goal))}%"></div></div>` : '')}
        ${kpi('Lines changed', 'ri-git-commit-line', `<span class="add">+${num(c.linesAdded)}</span> <span class="del">−${num(c.linesDeleted)}</span>`,
          `${num(c.edits)} edits · ${num(c.charsAdded)} chars typed`)}
      </div>
      <div class="grid kpi">
        ${kpi('Sessions', 'ri-timer-line', num(sess.length), sess.length ? `avg ${fmtDur(avgSess)} · longest ${fmtDur(longest)}` : 'No sessions yet')}
        ${kpi('Top language', 'ri-code-s-slash-line', topLang ? esc(langName(topLang[0])) : '—', topLang ? `${fmtDur(topLang[1].ms)} · ${pct(topLang[1].ms, A.total)}% of time` : '')}
        ${kpi('Streak', 'ri-fire-line', `${st.current} ${st.current === 1 ? 'day' : 'days'}`, `best ${st.best} ${st.best === 1 ? 'day' : 'days'}`)}
        ${kpi('Peak hour', 'ri-sun-foggy-line', A.total ? `${pad(peakHour)}:00` : '—', A.total ? `${fmtDur(A.hours[peakHour])} at this hour` : '')}
      </div>
      <div class="grid">
        ${card(single ? 'Hourly activity' : 'Daily activity',
          single ? `Time per hour on ${longDate(b.from)}, split by activity type` : 'Time per day — hover a bar for the breakdown',
          `<div id="chart-main"></div><div class="legend" id="legend-main"></div>`, { action: breakdownToggle })}
      </div>
      <div class="grid two">
        ${card('Languages', 'Share of tracked time', `<div class="donut-wrap"><div id="chart-langs"></div><div id="list-langs"></div></div>`)}
        ${card('Activity type', 'How your time was spent', renderCategories(A))}
      </div>
      <div class="grid two">
        ${card('Top files', 'Click a file to open it', `<div id="list-files"></div>`, { action: `<button class="btn" data-goto="files">View all ${icon('ri-arrow-right-line')}</button>` })}
        ${card('Projects', 'Time per workspace folder', `<div id="list-projects"></div>`)}
      </div>
      <div class="grid wide-left">
        ${card('Time of day', 'When you do your best work', `<div id="chart-hours"></div>`)}
        ${card('Branches', 'Git branches you worked on', `<div id="list-branches"></div>`)}
      </div>`;
  }

  function renderCategories(A) {
    const total = CATS.reduce((s, c) => s + (A.categories[c.key] || 0), 0);
    if (!total) return empty('No activity in this period');
    return `<div class="stack-bar" style="margin-bottom:16px">${CATS.filter(c => A.categories[c.key]).map(c =>
      `<div class="cat-seg" data-cat="${c.key}" style="width:${(A.categories[c.key] / total) * 100}%;background:${c.color}"></div>`).join('')}</div>
      ${barList(CATS.map(c => ({ label: c.name, value: A.categories[c.key] || 0, color: c.color, title: c.desc,
        iconHtml: icon(c.icon, ' style="color:var(--muted-foreground)"') })), { total })}`;
  }

  function mountOverview(A, P, b) {
    $app.querySelectorAll('[data-breakdown]').forEach(el => el.addEventListener('click', () => { state.breakdown = el.dataset.breakdown; persist(); render(); }));
    $app.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => { state.tab = el.dataset.goto; persist(); render(); }));
    $app.querySelectorAll('.cat-seg').forEach(el => {
      const c = CATS.find(x => x.key === el.dataset.cat);
      bindTip(el, () => tipRows(null, [{ label: c.name, value: fmtDur(A.categories[c.key]), color: c.color }]));
    });

    const main = document.getElementById('chart-main');
    const legend = document.getElementById('legend-main');
    let series, labels, xLabel, title;
    if (b.from === b.to) {
      labels = A.hours.map((_, h) => `${pad(h)}:00`);
      series = CATS.map(c => ({ key: c.key, name: c.name, color: c.color, values: A.hourCats.map(hc => hc[c.key] || 0) })).filter(s => s.values.some(v => v));
      xLabel = i => (i % 3 === 0 ? `${pad(i)}h` : '');
      title = i => `${pad(i)}:00 – ${pad((i + 1) % 24)}:00`;
    } else {
      labels = datesBetween(b.from, b.to);
      const n = labels.length;
      xLabel = i => n <= 14 ? parseKey(labels[i]).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : shortDate(labels[i]);
      title = i => longDate(labels[i]);
      series = buildDailySeries(A, labels);
    }
    Charts.columns(main, { labels, series, xLabel, title, height: 260, ariaLabel: 'Activity over time',
      onClick: b.from === b.to ? null : i => { state.sessionDay = labels[i]; state.tab = 'sessions'; persist(); render(); } });
    legend.innerHTML = series.length > 1 ? series.map(s => `<span><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('') : '';

    // Languages
    const langs = Object.entries(A.languages).filter(([, s]) => s.ms > 0).sort((x, y) => y[1].ms - x[1].ms);
    const donutItems = foldOther(langs.map(([l, s]) => ({ key: l, name: langName(l), value: s.ms, color: langColor(l) })));
    Charts.donut(document.getElementById('chart-langs'), { items: donutItems, centerValue: fmtDur(A.total), centerLabel: 'total', ariaLabel: 'Languages' });
    document.getElementById('list-langs').innerHTML = barList(donutItems.slice(0, 6).map(i => ({ label: i.name, value: i.value, color: i.color })), { total: A.total });

    // Files
    const files = Object.values(A.files).filter(f => f.ms > 0).sort((x, y) => y.ms - x.ms).slice(0, 8);
    const fl = document.getElementById('list-files');
    fl.innerHTML = barList(files.map(f => ({ labelHtml: fileLabel(f.path), value: f.ms, color: langColor(f.language), title: `${f.project} · ${f.path} · ${langName(f.language)}` })), { total: A.total, onClick: true });
    fl.querySelectorAll('.bar-row').forEach(el => el.addEventListener('click', () => {
      const f = files[+el.dataset.idx];
      vscode.postMessage({ type: 'openFile', project: f.project, path: f.path });
    }));

    // Projects
    const projs = Object.entries(A.projects).filter(([, p]) => p.ms > 0).sort((x, y) => y[1].ms - x[1].ms).slice(0, 8);
    const pl = document.getElementById('list-projects');
    pl.innerHTML = barList(projs.map(([n, p]) => ({ label: n, value: p.ms, color: projColor(n) })), { total: A.total, onClick: true });
    pl.querySelectorAll('.bar-row').forEach(el => el.addEventListener('click', () => { state.project = projs[+el.dataset.idx][0]; persist(); render(); }));

    // Hours
    Charts.columns(document.getElementById('chart-hours'), {
      labels: A.hours.map((_, h) => h), height: 200, ariaLabel: 'Time of day',
      series: [{ key: 'time', name: 'Tracked', color: 'var(--s1)', values: A.hours }],
      xLabel: i => (i % 3 === 0 ? `${pad(i)}h` : ''), title: i => `${pad(i)}:00 – ${pad((i + 1) % 24)}:00`
    });

    const branches = Object.entries(A.branches).sort((x, y) => y[1] - x[1]).slice(0, 8);
    document.getElementById('list-branches').innerHTML = barList(branches.map(([n, v]) => ({
      labelHtml: (() => { const [p, br] = n.split(' · '); return `${icon('ri-git-branch-line', ' style="color:var(--muted-foreground)"')} <strong>${esc(br)}</strong> <span class="muted">${esc(p)}</span>`; })(),
      value: v
    })), { emptyText: 'No git branches detected', total: A.total });
  }

  function foldOther(items) {
    const keep = items.filter(i => i.color !== 'var(--other)');
    const rest = items.filter(i => i.color === 'var(--other)');
    if (rest.length) keep.push({ key: '__other', name: `Other (${rest.length})`, value: rest.reduce((s, i) => s + i.value, 0), color: 'var(--other)' });
    return keep;
  }

  function buildDailySeries(A, labels) {
    if (state.breakdown === 'category') {
      return CATS.map(c => ({ key: c.key, name: c.name, color: c.color, values: labels.map(d => (A.perDay[d] && A.perDay[d].cats[c.key]) || 0) }))
        .filter(s => s.values.some(v => v));
    }
    const field = state.breakdown === 'project' ? 'projs' : 'langs';
    const colorFn = state.breakdown === 'project' ? projColor : langColor;
    const nameFn = state.breakdown === 'project' ? (x => x) : langName;
    const totals = {};
    labels.forEach(d => { const pd = A.perDay[d]; if (pd) for (const [k, v] of Object.entries(pd[field])) totals[k] = (totals[k] || 0) + v; });
    const keys = Object.keys(totals).filter(k => totals[k] > 0).sort((a, b) => totals[b] - totals[a]);
    const main = keys.filter(k => colorFn(k) !== 'var(--other)');
    const other = keys.filter(k => colorFn(k) === 'var(--other)');
    const series = main.map(k => ({ key: k, name: nameFn(k), color: colorFn(k), values: labels.map(d => (A.perDay[d] && A.perDay[d][field][k]) || 0) }));
    if (other.length) series.push({ key: '__other', name: 'Other', color: 'var(--other)', values: labels.map(d => other.reduce((s, k) => s + ((A.perDay[d] && A.perDay[d][field][k]) || 0), 0)) });
    // Remainder (time with no language, e.g. terminal without an open file) so the stack sums to the total.
    if (field === 'langs') {
      const rem = labels.map((d, i) => Math.max(0, ((A.perDay[d] && A.perDay[d].ms) || 0) - series.reduce((s, se) => s + se.values[i], 0)));
      if (rem.some(v => v > 30000)) series.push({ key: '__none', name: 'No file', color: 'var(--muted-foreground)', values: rem });
    }
    return series;
  }

  // ---------------- languages
  function tabLanguages(A) {
    const langs = Object.entries(A.languages).filter(([, s]) => s.ms > 0 || s.edits > 0).sort((x, y) => y[1].ms - x[1].ms);
    const rows = langs.map(([l, s]) => `<tr>
        <td><span class="swatch" style="background:${langColor(l)};margin-right:8px"></span>${esc(langName(l))} <span class="badge subtle">${esc(l)}</span></td>
        <td class="num">${fmtDur(s.ms)}</td>
        <td class="num" style="width:160px"><div style="display:flex;align-items:center;gap:8px;justify-content:flex-end"><div class="progress" style="width:90px;margin:0"><div style="width:${pct(s.ms, A.total)}%;background:${langColor(l)}"></div></div><span class="muted">${pct(s.ms, A.total)}%</span></div></td>
        <td class="num">${num(s.files.size)}</td>
        <td class="num">${num(s.edits)}</td>
        <td class="num add">+${num(s.linesAdded)}</td>
        <td class="num del">−${num(s.linesDeleted)}</td>
        <td class="num">${num(s.charsAdded)}</td>
      </tr>`).join('');
    return `<div class="grid wide-left">
        ${card('Language breakdown', `${langs.length} languages in this period`, langs.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Language</th><th class="num">Time</th><th class="num">Share</th><th class="num">Files</th><th class="num">Edits</th><th class="num">Lines +</th><th class="num">Lines −</th><th class="num">Chars typed</th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : empty('No languages recorded'))}
        ${card('Distribution', 'Share of tracked time', `<div style="display:grid;place-items:center"><div id="chart-langs-big"></div></div><div class="legend" id="legend-langs"></div>`)}
      </div>
      <div class="grid">${card('Languages over time', 'Daily time per language', `<div id="chart-lang-days"></div><div class="legend" id="legend-lang-days"></div>`)}</div>`;
  }

  function mountLanguages(A, P, b) {
    const langs = Object.entries(A.languages).filter(([, s]) => s.ms > 0).sort((x, y) => y[1].ms - x[1].ms);
    const items = foldOther(langs.map(([l, s]) => ({ key: l, name: langName(l), value: s.ms, color: langColor(l) })));
    Charts.donut(document.getElementById('chart-langs-big'), { items, size: 240, centerValue: String(langs.length), centerLabel: langs.length === 1 ? 'language' : 'languages' });
    document.getElementById('legend-langs').innerHTML = items.map(i => `<span><span class="swatch" style="background:${i.color}"></span>${esc(i.name)} · ${pct(i.value, A.total)}%</span>`).join('');
    const labels = datesBetween(b.from, b.to);
    const prev = state.breakdown; state.breakdown = 'language';
    const series = buildDailySeries(A, labels).filter(s => s.key !== '__none');
    state.breakdown = prev;
    Charts.columns(document.getElementById('chart-lang-days'), {
      labels, series, height: 240, title: i => longDate(labels[i]),
      xLabel: i => labels.length <= 14 ? parseKey(labels[i]).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : shortDate(labels[i])
    });
    document.getElementById('legend-lang-days').innerHTML = series.length > 1 ? series.map(s => `<span><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('') : '';
  }

  // ---------------- files
  function sortedFiles(A) {
    const q = state.fileQuery.trim().toLowerCase();
    const { key, dir } = state.fileSort;
    return Object.values(A.files)
      .filter(f => !q || f.path.toLowerCase().includes(q) || f.project.toLowerCase().includes(q) || langName(f.language).toLowerCase().includes(q))
      .sort((x, y) => {
        const a = x[key], b = y[key];
        if (typeof a === 'string') return a.localeCompare(b) * dir;
        return ((a || 0) - (b || 0)) * dir;
      });
  }

  function tabFiles(A) {
    const all = Object.values(A.files);
    const cols = [
      ['path', 'File', ''], ['project', 'Project', ''], ['language', 'Language', ''], ['ms', 'Time', 'num'], ['edits', 'Edits', 'num'],
      ['linesAdded', 'Lines +', 'num'], ['linesDeleted', 'Lines −', 'num'], ['saves', 'Saves', 'num'], ['opens', 'Opens', 'num'], ['last', 'Last active', 'num']
    ];
    const totals = all.reduce((t, f) => { t.edits += f.edits; t.saves += f.saves; return t; }, { edits: 0, saves: 0 });
    return `
      <div class="grid kpi">
        ${kpi('Files touched', 'ri-file-copy-2-line', num(all.length), `${num(all.filter(f => f.edits > 0).length)} edited`)}
        ${kpi('Edits', 'ri-edit-line', num(totals.edits), `${num(A.counters.charsAdded)} chars typed · ${num(A.counters.charsDeleted)} deleted`)}
        ${kpi('Saves', 'ri-save-3-line', num(totals.saves), `${num(A.counters.opens)} file opens`)}
        ${kpi('File operations', 'ri-folder-transfer-line', num((A.counters.filesCreated || 0) + (A.counters.filesDeleted || 0) + (A.counters.filesRenamed || 0)),
          `${num(A.counters.filesCreated)} created · ${num(A.counters.filesDeleted)} deleted · ${num(A.counters.filesRenamed)} renamed`)}
      </div>
      <div class="card">
        <div class="card-header">
          <div><h3 class="card-title">All files</h3><p class="card-desc" id="files-count"></p></div>
          <div class="input-wrap">${icon('ri-search-line')}<input id="file-search" class="input" placeholder="Filter files, projects, languages…" value="${esc(state.fileQuery)}"></div>
        </div>
        <div class="card-content"><div class="table-wrap"><table>
          <thead><tr>${cols.map(([k, n, cls]) => `<th class="sortable ${cls}" data-sort="${k}">${n}${state.fileSort.key === k ? ' ' + icon(state.fileSort.dir < 0 ? 'ri-arrow-down-s-line' : 'ri-arrow-up-s-line') : ''}</th>`).join('')}</tr></thead>
          <tbody id="files-body"></tbody>
        </table></div></div>
      </div>`;
  }

  function mountFiles(A) {
    const body = document.getElementById('files-body');
    const count = document.getElementById('files-count');
    const LIMIT = 500;
    const draw = () => {
      const files = sortedFiles(A);
      count.textContent = files.length > LIMIT ? `Showing ${LIMIT} of ${num(files.length)} files` : `${num(files.length)} files`;
      body.innerHTML = files.length ? files.slice(0, LIMIT).map((f, i) => `<tr class="clickable" data-i="${i}" title="Open ${esc(f.path)}">
          <td class="file-cell">${fileLabel(f.path)}</td>
          <td class="muted">${esc(f.project)}</td>
          <td><span class="swatch" style="background:${langColor(f.language)};margin-right:6px"></span>${esc(langName(f.language))}</td>
          <td class="num"><strong>${fmtDur(f.ms)}</strong></td>
          <td class="num">${num(f.edits)}</td>
          <td class="num add">+${num(f.linesAdded)}</td>
          <td class="num del">−${num(f.linesDeleted)}</td>
          <td class="num">${num(f.saves)}</td>
          <td class="num">${num(f.opens)}</td>
          <td class="num muted">${shortDate(f.last)}</td>
        </tr>`).join('') : `<tr><td colspan="10">${empty('No files match')}</td></tr>`;
      body.querySelectorAll('tr.clickable').forEach(tr => tr.addEventListener('click', () => {
        const f = files[+tr.dataset.i];
        vscode.postMessage({ type: 'openFile', project: f.project, path: f.path });
      }));
    };
    draw();
    document.getElementById('file-search').addEventListener('input', e => { state.fileQuery = e.target.value; draw(); });
    $app.querySelectorAll('[data-sort]').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.sort;
      state.fileSort = state.fileSort.key === k ? { key: k, dir: -state.fileSort.dir } : { key: k, dir: ['path', 'project', 'language'].includes(k) ? 1 : -1 };
      persist(); render();
    }));
  }

  // ---------------- projects
  function tabProjects(A) {
    const projs = Object.entries(A.projects).sort((x, y) => y[1].ms - x[1].ms);
    const rows = projs.map(([n, p], i) => {
      const top = Object.entries(p.langs).sort((a, b) => b[1] - a[1])[0];
      return `<tr class="clickable" data-i="${i}" title="Filter dashboard to ${esc(n)}">
        <td><span class="swatch" style="background:${projColor(n)};margin-right:8px"></span><strong>${esc(n)}</strong></td>
        <td class="num"><strong>${fmtDur(p.ms)}</strong></td>
        <td class="num muted">${pct(p.ms, A.total)}%</td>
        <td class="num">${num(p.days)}</td>
        <td>${top ? esc(langName(top[0])) : '—'}</td>
        <td class="num">${num(p.edits)}</td>
        <td class="num add">+${num(p.linesAdded)}</td>
        <td class="num del">−${num(p.linesDeleted)}</td>
        <td class="num">${num(p.commits)}</td>
        <td class="num muted">${shortDate(p.last)}</td>
      </tr>`;
    }).join('');
    return `<div class="grid">${card('Projects', 'Click a project to focus the whole dashboard on it', projs.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Project</th><th class="num">Time</th><th class="num">Share</th><th class="num">Active days</th><th>Top language</th><th class="num">Edits</th><th class="num">Lines +</th><th class="num">Lines −</th><th class="num">Commits</th><th class="num">Last active</th></tr></thead>
        <tbody id="proj-body">${rows}</tbody></table></div>` : empty('No projects in this period'))}</div>
      <div class="grid wide-left">
        ${card('Projects over time', 'Daily time per project', `<div id="chart-proj-days"></div><div class="legend" id="legend-proj-days"></div>`)}
        ${card('Branches', 'Time per git branch', `<div id="list-branches-all"></div>`)}
      </div>`;
  }

  function mountProjects(A, P, b) {
    const projs = Object.entries(A.projects).sort((x, y) => y[1].ms - x[1].ms);
    $app.querySelectorAll('#proj-body tr.clickable').forEach(tr => tr.addEventListener('click', () => {
      state.project = projs[+tr.dataset.i][0]; state.tab = 'overview'; persist(); render();
    }));
    const labels = datesBetween(b.from, b.to);
    const prev = state.breakdown; state.breakdown = 'project';
    const series = buildDailySeries(A, labels);
    state.breakdown = prev;
    Charts.columns(document.getElementById('chart-proj-days'), {
      labels, series, height: 240, title: i => longDate(labels[i]),
      xLabel: i => labels.length <= 14 ? parseKey(labels[i]).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : shortDate(labels[i])
    });
    document.getElementById('legend-proj-days').innerHTML = series.length > 1 ? series.map(s => `<span><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('') : '';
    const branches = Object.entries(A.branches).sort((x, y) => y[1] - x[1]).slice(0, 15);
    document.getElementById('list-branches-all').innerHTML = barList(branches.map(([n, v]) => {
      const [p, br] = n.split(' · ');
      return { labelHtml: `${icon('ri-git-branch-line', ' style="color:var(--muted-foreground)"')} <strong>${esc(br)}</strong> <span class="muted">${esc(p)}</span>`, value: v };
    }), { emptyText: 'No git branches detected', total: A.total });
  }

  // ---------------- activity
  function tabActivity(A) {
    const c = A.counters;
    const stats = [
      ['ri-edit-line', 'Edits', c.edits], ['ri-keyboard-line', 'Chars typed', c.charsAdded], ['ri-delete-back-2-line', 'Chars deleted', c.charsDeleted],
      ['ri-add-line', 'Lines added', c.linesAdded], ['ri-subtract-line', 'Lines deleted', c.linesDeleted], ['ri-save-3-line', 'Saves', c.saves],
      ['ri-file-text-line', 'File opens', c.opens], ['ri-file-add-line', 'Files created', c.filesCreated], ['ri-file-reduce-line', 'Files deleted', c.filesDeleted],
      ['ri-file-edit-line', 'Files renamed', c.filesRenamed], ['ri-git-commit-line', 'Commits', c.commits], ['ri-bug-line', 'Debug sessions', c.debugSessions],
      ['ri-terminal-line', 'Terminal commands', c.terminalCommands], ['ri-timer-line', 'Sessions', A.sessions.length]
    ];
    return `<div class="grid">${card('Contribution calendar', `Daily tracked time over the last year${state.project !== 'all' ? ' · ' + esc(state.project) : ''} — click a day to see its sessions`, `<div id="chart-calendar"></div>
        <div class="legend" style="justify-content:flex-end">Less ${[0, 1, 2, 3, 4, 5].map(i => `<span class="swatch" style="background:var(--q${i});border:1px solid var(--border)"></span>`).join('')} More</div>`)}</div>
      <div class="grid wide-left">
        ${card('Weekly rhythm', 'Tracked time by weekday and hour', `<div id="chart-heat"></div>`)}
        ${card('Activity type', 'Coding vs reading vs debugging vs terminal', renderCategories(A))}
      </div>
      <div class="grid">${card('Detailed counters', 'Everything Pulse recorded in this period', `<div class="stat-grid">${stats.map(([ic, k, v]) =>
        `<div class="stat"><div class="k">${icon(ic)}${k}</div><div class="v">${num(v)}</div></div>`).join('')}</div>`)}</div>`;
  }

  function mountActivity(A) {
    const byDay = {};
    for (const day of state.days) {
      let ms = 0;
      for (const [pn, p] of Object.entries(day.projects)) if (state.project === 'all' || pn === state.project) ms += p.ms;
      byDay[day.date] = ms;
    }
    Charts.calendar(document.getElementById('chart-calendar'), {
      end: new Date(), weeks: 53, keyFor: keyOf, valueFor: k => byDay[k] || 0,
      onClick: k => { state.sessionDay = k; state.range = 'year'; state.tab = 'sessions'; persist(); render(); }
    });
    Charts.heatmap(document.getElementById('chart-heat'), { values: A.wdh, rowLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] });
    $app.querySelectorAll('.cat-seg').forEach(el => {
      const c = CATS.find(x => x.key === el.dataset.cat);
      bindTip(el, () => tipRows(null, [{ label: c.name, value: fmtDur(A.categories[c.key]), color: c.color }]));
    });
  }

  // ---------------- sessions
  function tabSessions(A, b) {
    const days = Object.keys(A.perDay).filter(d => A.perDay[d].ms > 0).sort().reverse();
    if (!state.sessionDay || !days.includes(state.sessionDay)) state.sessionDay = days[0] || null;
    const sess = A.sessions;
    const durations = sess.map(s => s.ms).sort((x, y) => x - y);
    const median = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
    const longest = durations.length ? durations[durations.length - 1] : 0;
    const total = durations.reduce((s, v) => s + v, 0);
    const LIMIT = 300;
    const rows = sess.slice(0, LIMIT).map(s => {
      const projs = Object.entries(s.projects || {}).sort((a, b2) => b2[1] - a[1]).map(([p]) => p);
      const langs = Object.entries(s.languages || {}).sort((a, b2) => b2[1] - a[1]).slice(0, 3);
      return `<tr>
        <td>${shortDate(s.date)}</td>
        <td class="num">${timeOf(s.start)} – ${timeOf(s.end)}</td>
        <td class="num"><strong>${fmtDur(s.ms)}</strong></td>
        <td>${projs.map(p => `<span class="swatch" style="background:${projColor(p)};margin-right:4px"></span>${esc(p)}`).join(', ') || '—'}</td>
        <td>${langs.map(([l]) => `<span class="badge subtle" style="margin-right:4px"><span class="swatch" style="background:${langColor(l)}"></span>${esc(langName(l))}</span>`).join('') || '—'}</td>
        <td class="num">${num(s.fileCount)}</td>
        <td class="num">${num(s.edits)}</td>
        <td class="num"><span class="add">+${num(s.linesAdded)}</span> <span class="del">−${num(s.linesDeleted)}</span></td>
      </tr>`;
    }).join('');
    return `<div class="grid kpi">
        ${kpi('Sessions', 'ri-timer-line', num(sess.length), `separated by ${state.live ? state.live.idleMinutes : 20}+ min of inactivity`)}
        ${kpi('Average length', 'ri-time-line', fmtDur(sess.length ? total / sess.length : 0), `median ${fmtDur(median)}`)}
        ${kpi('Longest session', 'ri-trophy-line', fmtDur(longest), longest ? shortDate(sess.find(s => s.ms === longest).date) : '')}
        ${kpi('Sessions per day', 'ri-calendar-check-line', A.activeDays ? (sess.length / A.activeDays).toFixed(1) : '0', `over ${A.activeDays} active days`)}
      </div>
      <div class="grid">${card('Day timeline', 'Every 5-minute block of tracked time; bars on top mark sessions',
        days.length ? `<div style="margin-bottom:12px"><select class="select" id="day-select" aria-label="Day">${days.map(d => `<option value="${d}" ${d === state.sessionDay ? 'selected' : ''}>${longDate(d)} · ${fmtDur(A.perDay[d].ms)}</option>`).join('')}</select></div>
         <div class="timeline"><div class="timeline-track" id="timeline-track"></div>
         <div class="timeline-axis">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => `<span>${pad(h % 24 === 0 && h ? 24 : h)}:00</span>`).join('')}</div></div>` : empty('No activity in this period'))}</div>
      <div class="grid">${card('Session log', sess.length > LIMIT ? `Latest ${LIMIT} of ${num(sess.length)} sessions` : `${num(sess.length)} sessions`, sess.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Date</th><th class="num">Time</th><th class="num">Duration</th><th>Projects</th><th>Languages</th><th class="num">Files</th><th class="num">Edits</th><th class="num">Lines</th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : empty('No sessions recorded'))}</div>`;
  }

  function mountSessions(A) {
    const sel = document.getElementById('day-select');
    if (!sel) return;
    sel.addEventListener('change', e => { state.sessionDay = e.target.value; render(); });
    const track = document.getElementById('timeline-track');
    const date = state.sessionDay;
    const day = state.days.find(d => d.date === date);
    if (!day) return;
    const buckets = new Array(288).fill(0);
    for (const [pn, p] of Object.entries(day.projects)) {
      if (state.project !== 'all' && pn !== state.project) continue;
      p.buckets.forEach((v, i) => { buckets[i] += v; });
    }
    const BUCKET = 5 * 60000;
    let html = '';
    buckets.forEach((v, i) => {
      if (!v) return;
      const h = Math.max(12, Math.min(100, (v / BUCKET) * 100));
      html += `<div class="tb" data-i="${i}" style="left:${(i / 288) * 100}%;width:calc(${100 / 288}% - 1px);height:${h * 0.8}%"></div>`;
    });
    const dayStart = parseKey(date).getTime();
    const sessions = (day.sessions || []).filter(s => state.project === 'all' || (s.projects && s.projects[state.project]));
    sessions.forEach((s, i) => {
      const l = Math.max(0, (s.start - dayStart) / 864e5) * 100;
      const r = Math.min(100, ((s.end - dayStart) / 864e5) * 100);
      html += `<div class="sess" data-s="${i}" style="left:${l}%;width:max(3px, ${r - l}%)"></div>`;
    });
    track.innerHTML = html;
    track.querySelectorAll('.tb').forEach(el => {
      const i = +el.dataset.i;
      const m = i * 5;
      bindTip(el, () => tipRows(`${pad(Math.floor(m / 60))}:${pad(m % 60)} – ${pad(Math.floor((m + 5) / 60) % 24)}:${pad((m + 5) % 60)}`, [{ label: 'Active', value: fmtDur(buckets[i]) }]));
    });
    track.querySelectorAll('.sess').forEach(el => {
      const s = sessions[+el.dataset.s];
      bindTip(el, () => tipRows(`Session ${timeOf(s.start)} – ${timeOf(s.end)}`, [
        { label: 'Active time', value: fmtDur(s.ms) }, { label: 'Edits', value: num(s.edits) },
        { label: 'Lines', value: `+${num(s.linesAdded)} / −${num(s.linesDeleted)}` }, { label: 'Files', value: num(s.fileCount) }
      ]));
    });
  }

  // ------------------------------------------------------------------ messaging & lifecycle
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'data') {
      state.days = msg.days || [];
      state.live = msg.live;
      state.loaded = true;
      render();
    } else if (msg.type === 'live') {
      const changedPause = !state.live || (state.live.state === 'paused') !== (msg.live.state === 'paused');
      state.live = msg.live;
      const badge = document.getElementById('live-badge');
      if (badge) badge.innerHTML = liveBadge();
      if (changedPause) {
        const btn = document.getElementById('btn-pause');
        if (btn) btn.innerHTML = msg.live.state === 'paused' ? icon('ri-play-line') + 'Resume' : icon('ri-pause-line') + 'Pause';
      }
    }
  });

  let resizeTimer, lastWidth = 0;
  new ResizeObserver(entries => {
    const w = Math.round(entries[0].contentRect.width);
    if (Math.abs(w - lastWidth) < 8) return;
    lastWidth = w;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  }).observe(document.body);

  vscode.postMessage({ type: 'ready' });
})();
