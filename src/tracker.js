'use strict';

const vscode = require('vscode');
const os = require('os');
const { dateKey, emptyStat, BUCKET_MINUTES } = require('./storage');

const TRACKED_SCHEMES = new Set([
  'file', 'untitled', 'vscode-remote', 'vscode-notebook-cell', 'vsls', 'vscode-vfs', 'wsl', 'vscode-userdata'
]);
const CODING_WINDOW_MS = 60 * 1000;      // an edit within the last minute means "coding" rather than "reading"
const TICK_MS = 5 * 1000;
const FLUSH_MS = 30 * 1000;
const OTHERS_CACHE_MS = 60 * 1000;

function formatDuration(ms, withSeconds = false) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (withSeconds && h === 0 && m < 5) {
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${s}s`;
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

class Tracker {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./storage').Storage} storage
   */
  constructor(context, storage) {
    this.context = context;
    this.storage = storage;
    this.paused = context.globalState.get('pulse.paused', false);
    this.session = null;           // current work session
    this.lastBeat = null;          // { time, ctx } — time after this is credited on the next beat
    this.lastActivity = 0;
    this.lastEditAt = 0;
    this.lastEditorAt = 0;
    this.lastTerminalAt = 0;
    this.focused = vscode.window.state.focused;
    this.excludeCache = new Map();
    this.othersCache = { date: '', ms: 0, at: 0 };
    this.git = null;
    this.listeners = new Set();
    this.readConfig();

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'pulse.openDashboard';
    context.subscriptions.push(this.statusBar);

    this.registerEvents();
    this.initGit();

    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);

    // If VS Code opens with a file already focused, count it as the start of activity.
    if (this.focused && vscode.window.activeTextEditor) this.beat('open', vscode.window.activeTextEditor.document);
    this.updateStatusBar();
  }

  readConfig() {
    const cfg = vscode.workspace.getConfiguration('pulse');
    this.idleMs = Math.max(1, cfg.get('idleTimeoutMinutes', 20)) * 60 * 1000;
    this.trackUnfocused = cfg.get('trackWhenUnfocused', false);
    this.goalMs = Math.max(0, cfg.get('dailyGoalHours', 4)) * 3600 * 1000;
    this.showStatusBar = cfg.get('showStatusBar', true);
    this.excludePatterns = cfg.get('excludePatterns', []);
    this.excludeCache.clear();
  }

  onDidChange(fn) { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }
  emit() { for (const fn of this.listeners) { try { fn(); } catch { /* ignore */ } } }

  // ---------------------------------------------------------------- events

  registerEvents() {
    const subs = this.context.subscriptions;
    const w = vscode.window;
    const ws = vscode.workspace;

    // Typing — the primary signal. Activity is detected on the very first keystroke.
    subs.push(ws.onDidChangeTextDocument(e => {
      if (!e.contentChanges.length || !this.isTracked(e.document)) return;
      // Ignore changes in background documents (formatters, git, etc.) unless it's the active editor.
      const active = w.activeTextEditor;
      if (!active || active.document !== e.document) {
        if (!(e.document.uri.scheme === 'vscode-notebook-cell')) return;
      }
      this.recordEdit(e.document, e.contentChanges);
    }));

    subs.push(w.onDidChangeActiveTextEditor(ed => { if (ed) this.beat('open', ed.document); }));
    subs.push(w.onDidChangeTextEditorSelection(e => this.beat('navigate', e.textEditor.document)));
    subs.push(w.onDidChangeTextEditorVisibleRanges(e => this.beat('scroll', e.textEditor.document)));
    subs.push(ws.onDidSaveTextDocument(doc => {
      if (!this.isTracked(doc)) return;
      this.beat('save', doc);
      this.bumpFile(doc, f => { f.saves = (f.saves || 0) + 1; }, 'saves');
    }));
    subs.push(ws.onDidOpenTextDocument(doc => {
      if (!this.isTracked(doc) || !this.focused) return;
      this.bumpFile(doc, f => { f.opens = (f.opens || 0) + 1; }, 'opens');
    }));

    // File system operations performed from VS Code.
    subs.push(ws.onDidCreateFiles(e => this.bumpCounter('filesCreated', e.files.length)));
    subs.push(ws.onDidDeleteFiles(e => this.bumpCounter('filesDeleted', e.files.length)));
    subs.push(ws.onDidRenameFiles(e => this.bumpCounter('filesRenamed', e.files.length)));

    // Window focus.
    subs.push(w.onDidChangeWindowState(state => {
      if (state.focused === this.focused) return;
      this.focused = state.focused;
      if (state.focused) {
        this.beat('focus', w.activeTextEditor && w.activeTextEditor.document);
      } else if (!this.trackUnfocused) {
        this.commitPending(Date.now());
        this.lastBeat = null;
        this.updateStatusBar();
      }
    }));

    // Terminal activity.
    const termBeat = () => { this.lastTerminalAt = Date.now(); this.beat('terminal'); };
    subs.push(w.onDidOpenTerminal(termBeat));
    subs.push(w.onDidChangeActiveTerminal(t => { if (t) termBeat(); }));
    if (typeof w.onDidChangeTerminalState === 'function') subs.push(w.onDidChangeTerminalState(termBeat));
    if (typeof w.onDidStartTerminalShellExecution === 'function') {
      subs.push(w.onDidStartTerminalShellExecution(() => { termBeat(); this.bumpCounter('terminalCommands', 1); }));
      subs.push(w.onDidEndTerminalShellExecution(termBeat));
    }

    // Debugging.
    subs.push(vscode.debug.onDidStartDebugSession(() => { this.bumpCounter('debugSessions', 1); this.beat('debug'); }));
    subs.push(vscode.debug.onDidChangeActiveDebugSession(() => this.beat('debug')));
    subs.push(vscode.debug.onDidChangeBreakpoints(() => this.beat('debug')));
    if (typeof vscode.debug.onDidChangeActiveStackItem === 'function') {
      subs.push(vscode.debug.onDidChangeActiveStackItem(() => this.beat('debug')));
    }

    subs.push(ws.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('pulse')) { this.readConfig(); this.updateStatusBar(); }
    }));
  }

  async initGit() {
    try {
      const ext = vscode.extensions.getExtension('vscode.git');
      if (!ext) return;
      const exports = ext.isActive ? ext.exports : await ext.activate();
      const api = exports.getAPI(1);
      this.git = api;
      const hook = repo => {
        if (typeof repo.onDidCommit === 'function') {
          this.context.subscriptions.push(repo.onDidCommit(() => {
            this.bumpCounter('commits', 1, repo.rootUri);
            this.beat('commit');
          }));
        }
      };
      api.repositories.forEach(hook);
      this.context.subscriptions.push(api.onDidOpenRepository(hook));
    } catch { /* git extension unavailable */ }
  }

  // ---------------------------------------------------------------- context

  isTracked(doc) {
    if (!doc || !TRACKED_SCHEMES.has(doc.uri.scheme)) return false;
    const key = doc.uri.toString();
    let excluded = this.excludeCache.get(key);
    if (excluded === undefined) {
      excluded = this.excludePatterns.some(p => {
        try { return vscode.languages.match({ pattern: p }, doc) > 0; } catch { return false; }
      });
      this.excludeCache.set(key, excluded);
      if (this.excludeCache.size > 2000) this.excludeCache.clear();
    }
    return !excluded;
  }

  projectFor(uri) {
    if (uri) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder) return folder.name;
    }
    return vscode.workspace.name || 'No Project';
  }

  filePathFor(doc) {
    if (doc.isUntitled) return `Untitled (${doc.languageId})`;
    const uri = doc.uri.scheme === 'vscode-notebook-cell' ? doc.uri.with({ scheme: 'file', fragment: '' }) : doc.uri;
    let rel = vscode.workspace.asRelativePath(uri, false);
    const home = os.homedir();
    if (rel.startsWith(home)) rel = '~' + rel.slice(home.length);
    return rel;
  }

  branchFor(uri) {
    if (!this.git || !uri) return null;
    let best = null;
    for (const repo of this.git.repositories) {
      const root = repo.rootUri.fsPath;
      if (uri.fsPath.startsWith(root) && (!best || root.length > best.rootUri.fsPath.length)) best = repo;
    }
    const head = best && best.state && best.state.HEAD;
    return head ? (head.name || (head.commit ? head.commit.slice(0, 7) : null)) : null;
  }

  contextFor(doc) {
    const now = Date.now();
    if (!doc || !this.isTracked(doc)) {
      const ed = vscode.window.activeTextEditor;
      doc = ed && this.isTracked(ed.document) ? ed.document : null;
    }
    let category;
    if (this.lastTerminalAt > this.lastEditorAt && now - this.lastTerminalAt < this.idleMs) category = 'terminal';
    else if (vscode.debug.activeDebugSession) category = 'debugging';
    else if (now - this.lastEditAt < CODING_WINDOW_MS) category = 'coding';
    else category = 'reading';

    if (!doc) {
      return { project: this.projectFor(null), file: null, language: category === 'terminal' ? 'terminal' : null, branch: null, category };
    }
    return {
      project: this.projectFor(doc.uri),
      file: this.filePathFor(doc),
      language: doc.languageId,
      branch: this.branchFor(doc.uri),
      category
    };
  }

  // ---------------------------------------------------------------- core timing

  /**
   * Register activity. Time since the previous beat is credited (if it was within the idle window),
   * so idle stretches longer than the timeout are never counted.
   */
  beat(kind, doc) {
    if (this.paused) return;
    if (!this.focused && !this.trackUnfocused) return;
    if (doc && !this.isTracked(doc)) return;
    const now = Date.now();
    if (kind !== 'terminal' && kind !== 'debug' && kind !== 'commit') this.lastEditorAt = now;

    const wasIdle = !this.session;
    if (this.session && now - this.lastActivity > this.idleMs) this.endSession();
    this.commitPending(now);

    const ctx = this.contextFor(doc);
    if (!this.session) this.startSession(now);
    this.session.lastActive = now;
    this.lastActivity = now;
    this.lastBeat = { time: now, ctx };
    if (wasIdle) { this.updateStatusBar(); this.emit(); }
  }

  /** Credit time between the last beat and `now`, if within the idle window. */
  commitPending(now) {
    if (!this.lastBeat) return;
    const gap = now - this.lastBeat.time;
    if (gap > 0 && gap <= this.idleMs) {
      const ctx = this.lastBeat.ctx;
      if (ctx.category === 'coding' && gap > CODING_WINDOW_MS) {
        // Typing stopped: the first minute counts as coding, the rest of the pause as reading/thinking.
        const split = this.lastBeat.time + CODING_WINDOW_MS;
        this.credit(ctx, this.lastBeat.time, split);
        this.credit({ ...ctx, category: 'reading' }, split, now);
      } else {
        this.credit(ctx, this.lastBeat.time, now);
      }
      this.lastBeat.time = now;
      this.updateStatusBar();
    }
  }

  /** Split [t0, t1) across 5-minute buckets (and therefore hours and days) and record it. */
  credit(ctx, t0, t1) {
    let t = t0;
    while (t < t1) {
      const d = new Date(t);
      const minute = d.getMinutes();
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(),
        Math.floor(minute / BUCKET_MINUTES) * BUCKET_MINUTES + BUCKET_MINUTES).getTime();
      const end = Math.min(t1, next);
      const ms = end - t;
      const date = dateKey(t);
      const p = this.storage.getProject(date, ctx.project);
      p.ms += ms;
      p.hours[d.getHours()] += ms;
      p.buckets[Math.floor((d.getHours() * 60 + minute) / BUCKET_MINUTES)] += ms;
      p.categories[ctx.category] = (p.categories[ctx.category] || 0) + ms;
      if (ctx.language) (p.languages[ctx.language] || (p.languages[ctx.language] = emptyStat())).ms += ms;
      if (ctx.branch) p.branches[ctx.branch] = (p.branches[ctx.branch] || 0) + ms;
      if (ctx.file) this.fileStat(p, ctx.file, ctx.language).ms += ms;
      this.storage.markDirty(date);
      if (this.session) {
        this.session.ms += ms;
        this.session.projects[ctx.project] = (this.session.projects[ctx.project] || 0) + ms;
        if (ctx.language) this.session.languages[ctx.language] = (this.session.languages[ctx.language] || 0) + ms;
        if (ctx.file) this.session.files[ctx.file] = 1;
      }
      t = end;
    }
  }

  fileStat(p, file, language) {
    return p.files[file] || (p.files[file] = Object.assign(emptyStat(), { language: language || 'plaintext', saves: 0, opens: 0 }));
  }

  recordEdit(doc, changes) {
    if (this.paused) return;
    const now = Date.now();
    this.lastEditAt = now;
    this.beat('edit', doc);
    if (!this.lastBeat) return; // unfocused and not tracking
    let linesAdded = 0, linesDeleted = 0, charsAdded = 0, charsDeleted = 0;
    for (const c of changes) {
      charsAdded += c.text.length;
      charsDeleted += c.rangeLength;
      linesAdded += (c.text.match(/\n/g) || []).length;
      linesDeleted += c.range.end.line - c.range.start.line;
    }
    const ctx = this.lastBeat.ctx;
    const date = dateKey(now);
    const p = this.storage.getProject(date, ctx.project);
    const delta = { edits: 1, linesAdded, linesDeleted, charsAdded, charsDeleted };
    for (const target of [
      p.counters,
      p.languages[ctx.language] || (p.languages[ctx.language] = emptyStat()),
      ctx.file ? this.fileStat(p, ctx.file, ctx.language) : {}
    ]) {
      for (const [k, v] of Object.entries(delta)) target[k] = (target[k] || 0) + v;
    }
    if (this.session) {
      this.session.edits += 1;
      this.session.linesAdded += linesAdded;
      this.session.linesDeleted += linesDeleted;
    }
    this.storage.markDirty(date);
  }

  bumpFile(doc, fn, counter) {
    if (this.paused) return;
    const date = dateKey(Date.now());
    const p = this.storage.getProject(date, this.projectFor(doc.uri));
    fn(this.fileStat(p, this.filePathFor(doc), doc.languageId));
    p.counters[counter] = (p.counters[counter] || 0) + 1;
    this.storage.markDirty(date);
  }

  bumpCounter(key, n, uri) {
    if (this.paused) return;
    const ed = vscode.window.activeTextEditor;
    const project = this.projectFor(uri || (ed && ed.document.uri));
    const date = dateKey(Date.now());
    const p = this.storage.getProject(date, project);
    p.counters[key] = (p.counters[key] || 0) + n;
    this.storage.markDirty(date);
  }

  startSession(now) {
    this.session = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      start: now, end: now, lastActive: now, ms: 0,
      edits: 0, linesAdded: 0, linesDeleted: 0,
      projects: {}, languages: {}, files: {}
    };
  }

  endSession() {
    if (!this.session) return;
    this.lastBeat = null;
    this.saveSession();
    this.session = null;
    this.updateStatusBar();
    this.emit();
  }

  /** Upsert the current session into the day it started on (so crashes lose at most ~30s). */
  saveSession() {
    const s = this.session;
    if (!s || s.ms <= 0) return;
    s.end = s.lastActive;
    const date = dateKey(s.start);
    const day = this.storage.getDay(date);
    const record = {
      id: s.id, start: s.start, end: s.end, ms: s.ms,
      edits: s.edits, linesAdded: s.linesAdded, linesDeleted: s.linesDeleted,
      projects: { ...s.projects }, languages: { ...s.languages }, fileCount: Object.keys(s.files).length
    };
    const idx = day.sessions.findIndex(x => x.id === s.id);
    if (idx >= 0) day.sessions[idx] = record; else day.sessions.push(record);
    this.storage.markDirty(date);
  }

  tick() {
    const now = Date.now();
    if (this.session && now - this.lastActivity > this.idleMs) {
      // Idle: close the session at the last moment of real activity. Nothing after it is counted.
      this.endSession();
    }
    this.updateStatusBar();
  }

  flush() {
    if (this.session) this.saveSession();
    this.storage.flush();
  }

  // ---------------------------------------------------------------- controls

  togglePause() {
    if (this.paused) {
      this.paused = false;
      this.beat('resume', vscode.window.activeTextEditor && vscode.window.activeTextEditor.document);
    } else {
      this.commitPending(Date.now());
      this.endSession();
      this.paused = true;
    }
    this.context.globalState.update('pulse.paused', this.paused);
    this.updateStatusBar();
    this.emit();
    return this.paused;
  }

  get state() {
    if (this.paused) return 'paused';
    if (!this.session) return 'idle';
    return 'active';
  }

  todayMs() {
    const date = dateKey(Date.now());
    const now = Date.now();
    if (this.othersCache.date !== date || now - this.othersCache.at > OTHERS_CACHE_MS) {
      let own = 0;
      for (const p of Object.values(this.storage.getDay(date).projects)) own += p.ms;
      this.othersCache = { date, ms: this.storage.totalForDate(date) - own, at: now };
    }
    let own = 0;
    for (const p of Object.values(this.storage.getDay(date).projects)) own += p.ms;
    return own + this.othersCache.ms;
  }

  updateStatusBar() {
    if (!this.showStatusBar) { this.statusBar.hide(); return; }
    const total = this.todayMs();
    const state = this.state;
    const icon = state === 'active' ? '$(pulse)' : state === 'paused' ? '$(debug-pause)' : '$(clock)';
    this.statusBar.text = `${icon} ${formatDuration(total)}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    const stateText = state === 'active'
      ? '$(pulse) **Tracking** — activity detected'
      : state === 'paused'
        ? '$(debug-pause) **Paused** — tracking disabled'
        : `$(clock) **Idle** — resumes on your next keystroke (timeout ${Math.round(this.idleMs / 60000)} min)`;
    md.appendMarkdown(`${stateText}\n\n`);
    md.appendMarkdown(`**Today:** ${formatDuration(total)}`);
    if (this.goalMs > 0) {
      const pct = Math.min(100, Math.round((total / this.goalMs) * 100));
      md.appendMarkdown(` · ${pct}% of ${formatDuration(this.goalMs)} goal`);
    }
    if (this.session && state === 'active') {
      md.appendMarkdown(`\n\n**Current session:** ${formatDuration(this.session.ms, true)} · ${this.session.edits} edits`);
    }
    md.appendMarkdown('\n\n[Open dashboard](command:pulse.openDashboard) · [' + (this.paused ? 'Resume' : 'Pause') + '](command:pulse.togglePause)');
    this.statusBar.tooltip = md;
    this.statusBar.backgroundColor = state === 'paused' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.statusBar.show();
  }

  liveStatus() {
    return {
      state: this.state,
      todayMs: this.todayMs(),
      goalMs: this.goalMs,
      idleMinutes: Math.round(this.idleMs / 60000),
      session: this.session ? { start: this.session.start, ms: this.session.ms, edits: this.session.edits } : null
    };
  }

  dispose() {
    clearInterval(this.tickTimer);
    clearInterval(this.flushTimer);
    if (this.lastBeat && this.session && Date.now() - this.lastActivity <= this.idleMs) this.commitPending(Date.now());
    this.flush();
  }
}

module.exports = { Tracker, formatDuration };
