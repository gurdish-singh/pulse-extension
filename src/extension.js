'use strict';

const vscode = require('vscode');
const fs = require('fs');
const { Storage, dateKey } = require('./storage');
const { Tracker, formatDuration } = require('./tracker');
const { Dashboard } = require('./dashboard');

let tracker;

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const dir = vscode.Uri.joinPath(context.globalStorageUri, 'data').fsPath;
  const storage = new Storage(dir, vscode.env.sessionId);
  tracker = new Tracker(context, storage);
  const dashboard = new Dashboard(context, storage, tracker);

  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('pulse.openDashboard', () => dashboard.open());

  cmd('pulse.togglePause', () => {
    const paused = tracker.togglePause();
    vscode.window.setStatusBarMessage(paused ? 'Pulse: tracking paused' : 'Pulse: tracking resumed', 2500);
  });

  cmd('pulse.showToday', () => {
    tracker.flush();
    const today = dateKey(Date.now());
    const [day] = storage.loadRange(today, today);
    if (!day) { vscode.window.showInformationMessage('Pulse: no activity recorded today yet.'); return; }
    const langs = {};
    let total = 0, edits = 0, added = 0, deleted = 0;
    for (const p of Object.values(day.projects)) {
      total += p.ms; edits += p.counters.edits || 0;
      added += p.counters.linesAdded || 0; deleted += p.counters.linesDeleted || 0;
      for (const [l, s] of Object.entries(p.languages)) langs[l] = (langs[l] || 0) + s.ms;
    }
    const top = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([l, ms]) => `${l} ${formatDuration(ms)}`).join(', ');
    vscode.window.showInformationMessage(
      `Pulse today: ${formatDuration(total)} · ${day.sessions.length} sessions · ${edits} edits · +${added}/−${deleted} lines${top ? ' · ' + top : ''}`,
      'Open Dashboard'
    ).then(choice => { if (choice) dashboard.open(); });
  });

  cmd('pulse.exportJson', async () => {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`pulse-export-${dateKey(Date.now())}.json`),
      filters: { JSON: ['json'] }
    });
    if (!target) return;
    tracker.flush();
    fs.writeFileSync(target.fsPath, JSON.stringify({ exportedAt: new Date().toISOString(), days: storage.loadRange(null, null) }, null, 2));
    vscode.window.showInformationMessage(`Pulse: exported to ${target.fsPath}`);
  });

  cmd('pulse.exportCsv', async () => {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`pulse-files-${dateKey(Date.now())}.csv`),
      filters: { CSV: ['csv'] }
    });
    if (!target) return;
    tracker.flush();
    const esc = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['date', 'project', 'file', 'language', 'minutes', 'edits', 'lines_added', 'lines_deleted', 'chars_added', 'chars_deleted', 'saves', 'opens']];
    for (const day of storage.loadRange(null, null)) {
      for (const [project, p] of Object.entries(day.projects)) {
        for (const [file, f] of Object.entries(p.files)) {
          rows.push([day.date, project, file, f.language, (f.ms / 60000).toFixed(2), f.edits, f.linesAdded, f.linesDeleted, f.charsAdded, f.charsDeleted, f.saves || 0, f.opens || 0]);
        }
      }
    }
    fs.writeFileSync(target.fsPath, rows.map(r => r.map(esc).join(',')).join('\n'));
    vscode.window.showInformationMessage(`Pulse: exported ${rows.length - 1} rows to ${target.fsPath}`);
  });

  cmd('pulse.openDataFolder', () => vscode.env.openExternal(vscode.Uri.file(dir)));

  cmd('pulse.deleteAllData', async () => {
    const ok = await vscode.window.showWarningMessage(
      'Delete ALL tracked time data from every window? This cannot be undone.', { modal: true }, 'Delete Everything');
    if (ok !== 'Delete Everything') return;
    tracker.endSession();
    storage.deleteAll();
    tracker.othersCache.at = 0;
    tracker.updateStatusBar();
    dashboard.sendData();
    vscode.window.showInformationMessage('Pulse: all data deleted.');
  });

  context.subscriptions.push({ dispose: () => tracker && tracker.dispose() });
}

function deactivate() {
  if (tracker) tracker.dispose();
  tracker = undefined;
}

module.exports = { activate, deactivate };
