'use strict';

const fs = require('fs');
const path = require('path');

const BUCKET_MINUTES = 5;
const BUCKETS_PER_DAY = (24 * 60) / BUCKET_MINUTES;
const CATEGORIES = ['coding', 'reading', 'debugging', 'terminal'];
const COUNTER_KEYS = [
  'edits', 'saves', 'opens', 'filesCreated', 'filesDeleted', 'filesRenamed',
  'commits', 'debugSessions', 'terminalCommands', 'linesAdded', 'linesDeleted',
  'charsAdded', 'charsDeleted'
];

function pad(n) { return String(n).padStart(2, '0'); }

/** Local-time YYYY-MM-DD for a timestamp. */
function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyCounters() {
  const c = {};
  for (const k of COUNTER_KEYS) c[k] = 0;
  return c;
}

function emptyStat() {
  return { ms: 0, edits: 0, linesAdded: 0, linesDeleted: 0, charsAdded: 0, charsDeleted: 0 };
}

function emptyProject() {
  const categories = {};
  for (const c of CATEGORIES) categories[c] = 0;
  return {
    ms: 0,
    hours: new Array(24).fill(0),
    buckets: new Array(BUCKETS_PER_DAY).fill(0),
    categories,
    languages: {},
    branches: {},
    files: {},
    counters: emptyCounters()
  };
}

function emptyDay(date) {
  return { version: 1, date, projects: {}, sessions: [] };
}

function addStat(target, src) {
  for (const k of Object.keys(src)) {
    if (typeof src[k] === 'number') target[k] = (target[k] || 0) + src[k];
  }
}

/** Merge day `src` into day `dst` (used to combine multiple windows / machines). */
function mergeDay(dst, src) {
  for (const [name, sp] of Object.entries(src.projects || {})) {
    const dp = dst.projects[name] || (dst.projects[name] = emptyProject());
    dp.ms += sp.ms || 0;
    (sp.hours || []).forEach((v, i) => { dp.hours[i] += v || 0; });
    (sp.buckets || []).forEach((v, i) => { dp.buckets[i] += v || 0; });
    for (const [k, v] of Object.entries(sp.categories || {})) dp.categories[k] = (dp.categories[k] || 0) + v;
    for (const [k, v] of Object.entries(sp.branches || {})) dp.branches[k] = (dp.branches[k] || 0) + v;
    for (const [k, v] of Object.entries(sp.languages || {})) addStat(dp.languages[k] || (dp.languages[k] = emptyStat()), v);
    for (const [k, v] of Object.entries(sp.files || {})) {
      const f = dp.files[k] || (dp.files[k] = Object.assign(emptyStat(), { language: v.language, saves: 0, opens: 0 }));
      if (!f.language && v.language) f.language = v.language;
      addStat(f, v);
    }
    addStat(dp.counters, sp.counters || {});
  }
  dst.sessions.push(...(src.sessions || []));
  return dst;
}

class Storage {
  /**
   * @param {string} dir   storage directory (shared by all windows)
   * @param {string} windowId  unique id of this window so concurrent windows never clobber each other
   */
  constructor(dir, windowId) {
    this.dir = dir;
    this.windowId = windowId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || 'window';
    this.days = new Map();
    this.dirty = new Set();
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(date) {
    return path.join(this.dir, `${date}__${this.windowId}.json`);
  }

  getDay(date) {
    let day = this.days.get(date);
    if (!day) {
      day = emptyDay(date);
      try {
        // Reload our own file if the extension host restarted within the same window.
        const raw = fs.readFileSync(this.fileFor(date), 'utf8');
        day = mergeDay(emptyDay(date), JSON.parse(raw));
      } catch { /* new day */ }
      this.days.set(date, day);
      // Keep memory small: forget days that are already flushed and not today/yesterday.
      if (this.days.size > 3) {
        for (const key of this.days.keys()) {
          if (key !== date && !this.dirty.has(key) && this.days.size > 3) this.days.delete(key);
        }
      }
    }
    return day;
  }

  getProject(date, project) {
    const day = this.getDay(date);
    return day.projects[project] || (day.projects[project] = emptyProject());
  }

  markDirty(date) { this.dirty.add(date); }

  flush() {
    for (const date of this.dirty) {
      const day = this.days.get(date);
      if (!day) continue;
      const file = this.fileFor(date);
      const tmp = file + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify(day));
        fs.renameSync(tmp, file);
      } catch (err) {
        console.error('[Pulse] failed to write', file, err);
        continue;
      }
    }
    this.dirty.clear();
  }

  listFiles() {
    try {
      return fs.readdirSync(this.dir).filter(f => /^\d{4}-\d{2}-\d{2}__.+\.json$/.test(f));
    } catch {
      return [];
    }
  }

  /** Load every day between from..to (inclusive, YYYY-MM-DD), merged across windows. */
  loadRange(from, to) {
    this.flush();
    const merged = new Map();
    for (const f of this.listFiles()) {
      const date = f.slice(0, 10);
      if ((from && date < from) || (to && date > to)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        mergeDay(merged.get(date) || merged.set(date, emptyDay(date)).get(date), data);
      } catch (err) {
        console.error('[Pulse] skipping corrupt file', f, err);
      }
    }
    return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Today's total across all windows (in-memory for this window, disk for others). */
  totalForDate(date) {
    let total = 0;
    const own = path.basename(this.fileFor(date));
    for (const f of this.listFiles()) {
      if (!f.startsWith(date) || f === own) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        for (const p of Object.values(data.projects || {})) total += p.ms || 0;
      } catch { /* ignore */ }
    }
    for (const p of Object.values(this.getDay(date).projects)) total += p.ms;
    return total;
  }

  deleteAll() {
    for (const f of this.listFiles()) {
      try { fs.unlinkSync(path.join(this.dir, f)); } catch { /* ignore */ }
    }
    this.days.clear();
    this.dirty.clear();
  }
}

module.exports = { Storage, dateKey, emptyStat, BUCKET_MINUTES, BUCKETS_PER_DAY, CATEGORIES };
