'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class Dashboard {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./storage').Storage} storage
   * @param {import('./tracker').Tracker} tracker
   */
  constructor(context, storage, tracker) {
    this.context = context;
    this.storage = storage;
    this.tracker = tracker;
    this.panel = null;
  }

  open() {
    if (this.panel) { this.panel.reveal(); this.sendData(); return; }
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('pulseDashboard', 'Pulse Dashboard', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media]
    });
    panel.iconPath = vscode.Uri.joinPath(media, 'icon.png');
    panel.webview.html = this.html(panel.webview, media);
    this.panel = panel;

    const disposables = [];
    disposables.push(panel.webview.onDidReceiveMessage(msg => this.onMessage(msg)));
    disposables.push(this.tracker.onDidChange(() => { this.sendLive(); this.sendData(); }));
    const liveTimer = setInterval(() => { if (panel.visible) this.sendLive(); }, 10000);
    const dataTimer = setInterval(() => { if (panel.visible) this.sendData(); }, 60000);
    disposables.push(panel.onDidChangeViewState(e => { if (e.webviewPanel.visible) { this.sendLive(); this.sendData(); } }));
    panel.onDidDispose(() => {
      clearInterval(liveTimer);
      clearInterval(dataTimer);
      disposables.forEach(d => d.dispose());
      this.panel = null;
    });
  }

  sendData() {
    if (!this.panel) return;
    this.tracker.flush();
    const days = this.storage.loadRange(null, null);
    this.panel.webview.postMessage({ type: 'data', days, live: this.tracker.liveStatus(), now: Date.now() });
  }

  sendLive() {
    if (!this.panel) return;
    this.panel.webview.postMessage({ type: 'live', live: this.tracker.liveStatus() });
  }

  async onMessage(msg) {
    switch (msg && msg.type) {
      case 'ready':
      case 'refresh':
        this.sendData();
        break;
      case 'togglePause':
        this.tracker.togglePause();
        this.sendLive();
        break;
      case 'command':
        if (typeof msg.command === 'string' && msg.command.startsWith('pulse.')) vscode.commands.executeCommand(msg.command);
        break;
      case 'openFile':
        this.openFile(msg.project, msg.path);
        break;
      case 'settings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'pulse.');
        break;
    }
  }

  async openFile(project, rel) {
    if (typeof rel !== 'string' || rel.startsWith('Untitled (')) return;
    const candidates = [];
    if (rel.startsWith('~')) candidates.push(path.join(os.homedir(), rel.slice(1)));
    else if (path.isAbsolute(rel)) candidates.push(rel);
    else {
      const folders = vscode.workspace.workspaceFolders || [];
      const named = folders.filter(f => f.name === project);
      for (const f of [...named, ...folders]) candidates.push(path.join(f.uri.fsPath, rel));
    }
    for (const file of candidates) {
      try {
        const uri = vscode.Uri.file(file);
        await vscode.workspace.fs.stat(uri);
        await vscode.window.showTextDocument(uri, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        return;
      } catch { /* try next */ }
    }
    vscode.window.showWarningMessage(`Pulse: "${rel}" is not available in the current workspace.`);
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = p => webview.asWebviewUri(vscode.Uri.joinPath(media, p));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('vendor/remixicon.css')}">
<link rel="stylesheet" href="${uri('dashboard.css')}">
<title>Pulse Dashboard</title>
</head>
<body>
<div id="app"><div class="boot"><i class="ri-loader-4-line spin"></i> Loading your activity…</div></div>
<div id="tooltip" class="tooltip" role="tooltip"></div>
<script nonce="${nonce}" src="${uri('charts.js')}"></script>
<script nonce="${nonce}" src="${uri('app.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { Dashboard };
