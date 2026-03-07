import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

// ─── Data types ───────────────────────────────────────────────────────────────

interface FileStatus {
  xy: string;
  filepath: string;
  origPath?: string;
  repoRoot: string;
}

type GroupKind = 'staged' | 'changes' | 'message' | 'repo';

// ─── Diff parsing ─────────────────────────────────────────────────────────────

interface DiffRow {
  kind: 'context' | 'removed' | 'added' | 'empty' | 'hunk';
  lineNum: number | null;
  text: string;
}

interface SideBySideRow {
  left:  DiffRow;
  right: DiffRow;
}

function parseDiff(diff: string): SideBySideRow[] {
  const result: SideBySideRow[] = [];
  const lines = diff.split('\n');
  let i = 0;
  let ln = 1, rn = 1;

  // Skip file header lines (---, +++) — jump to first hunk
  while (i < lines.length && !lines[i].startsWith('@@')) { i++; }

  while (i < lines.length) {
    const line = lines[i];

    // Hunk header ─────────────────────────────────────────────────────────
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (m) {
        ln = parseInt(m[1]);
        rn = parseInt(m[3]);
        result.push({
          left:  { kind: 'hunk', lineNum: null, text: line },
          right: { kind: 'hunk', lineNum: null, text: line },
        });
      }
      i++; continue;
    }

    // Collect a block of adjacent -/+ lines, then pair them side-by-side ──
    const removed: string[] = [];
    const added:   string[] = [];

    while (i < lines.length && (lines[i][0] === '-' || lines[i][0] === '+')) {
      if (lines[i][0] === '-') { removed.push(lines[i].slice(1)); }
      else                      { added.push(lines[i].slice(1)); }
      i++;
    }

    if (removed.length || added.length) {
      const n = Math.max(removed.length, added.length);
      for (let j = 0; j < n; j++) {
        const hasL = j < removed.length;
        const hasR = j < added.length;
        result.push({
          left:  hasL ? { kind: 'removed', lineNum: ln++, text: removed[j] }
                      : { kind: 'empty',   lineNum: null,  text: '' },
          right: hasR ? { kind: 'added',   lineNum: rn++, text: added[j] }
                      : { kind: 'empty',   lineNum: null,  text: '' },
        });
      }
      continue;
    }

    // Context line ─────────────────────────────────────────────────────────
    if (line[0] === ' ') {
      const text = line.slice(1);
      result.push({
        left:  { kind: 'context', lineNum: ln++, text },
        right: { kind: 'context', lineNum: rn++, text },
      });
    }

    i++;
  }

  return result;
}

// ─── HTML generation ──────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\t/g, '    ');
}

function rowHtml(row: DiffRow): string {
  const ln   = row.lineNum !== null ? String(row.lineNum) : '';
  const code = esc(row.text);
  return `<div class="row ${row.kind}"><span class="ln">${ln}</span><span class="code">${code}</span></div>`;
}

function buildHtml(filepath: string, rows: SideBySideRow[], xy: string): string {
  const leftHtml  = rows.map(r => rowHtml(r.left)).join('');
  const rightHtml = rows.map(r => rowHtml(r.right)).join('');
  const rightLabel = (xy[0] !== ' ' && xy[0] !== '?') ? 'Index (Staged)' : 'Working Tree';
  const fname = esc(filepath);

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family, 'Menlo', 'Courier New', monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Header ───────────────────────────────────────────────────── */
  #top-bar {
    display: grid;
    grid-template-columns: 1fr 1fr;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    border-bottom: 1px solid var(--vscode-editorGroup-border);
    flex-shrink: 0;
  }
  .top-label {
    padding: 5px 14px;
    font-size: 11px;
    color: var(--vscode-tab-inactiveForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .top-label:last-child { border-left: 1px solid var(--vscode-editorGroup-border); }
  .top-label strong { color: var(--vscode-editor-foreground); }

  /* ── Diff layout ──────────────────────────────────────────────── */
  #diff-wrapper {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr 1px 1fr;
    overflow: hidden;
  }
  #divider { background: var(--vscode-editorGroup-border); }

  .pane {
    overflow-y: scroll;
    overflow-x: auto;
  }

  /* ── Rows ─────────────────────────────────────────────────────── */
  .row {
    display: flex;
    min-height: 19px;
    line-height: 19px;
  }

  .ln {
    min-width: 52px;
    text-align: right;
    padding-right: 12px;
    padding-left: 4px;
    color: var(--vscode-editorLineNumber-foreground);
    border-right: 1px solid var(--vscode-editorGroup-border);
    user-select: none;
    flex-shrink: 0;
    font-size: 11px;
    line-height: 19px;
  }

  .code {
    padding-left: 12px;
    white-space: pre;
    flex: 1;
  }

  /* context — no highlight */
  .row.context {}

  /* removed (left side) */
  .row.removed {
    background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.12));
  }
  .row.removed .ln   { color: #f14c4c; }
  .row.removed .code { color: var(--vscode-diffEditor-removedTextForeground, #f14c4c); }

  /* added (right side) */
  .row.added {
    background: var(--vscode-diffEditor-insertedLineBackground, rgba(0, 255, 0, 0.08));
  }
  .row.added .ln   { color: #23d18b; }
  .row.added .code { color: var(--vscode-diffEditor-insertedTextForeground, #23d18b); }

  /* empty placeholder (keeps rows aligned) */
  .row.empty {
    background: var(--vscode-editor-background);
    opacity: 0.35;
  }
  .row.empty .code::before { content: ''; }

  /* hunk header */
  .row.hunk {
    background: var(--vscode-editorGroupHeader-tabsBackground);
    border-top: 1px solid var(--vscode-editorGroup-border);
    border-bottom: 1px solid var(--vscode-editorGroup-border);
  }
  .row.hunk .ln   { color: var(--vscode-tab-inactiveForeground); }
  .row.hunk .code {
    color: var(--vscode-tab-inactiveForeground);
    font-style: italic;
    font-size: 11px;
  }
</style>
</head>
<body>

<div id="top-bar">
  <div class="top-label">&#8592; <strong>HEAD</strong> &nbsp;${fname}</div>
  <div class="top-label">&#8594; <strong>${rightLabel}</strong> &nbsp;${fname}</div>
</div>

<div id="diff-wrapper">
  <div class="pane" id="pane-left">${leftHtml}</div>
  <div id="divider"></div>
  <div class="pane" id="pane-right">${rightHtml}</div>
</div>

<script>
  const L = document.getElementById('pane-left');
  const R = document.getElementById('pane-right');
  let lock = false;
  L.addEventListener('scroll', () => { if (!lock) { lock = true; R.scrollTop = L.scrollTop; R.scrollLeft = L.scrollLeft; lock = false; } });
  R.addEventListener('scroll', () => { if (!lock) { lock = true; L.scrollTop = R.scrollTop; L.scrollLeft = R.scrollLeft; lock = false; } });
</script>

</body>
</html>`;
}

// ─── DiffPanel (DP) ───────────────────────────────────────────────────────────

class DiffPanel {
  static current?: DiffPanel;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];

  static async createOrShow(status: FileStatus): Promise<void> {
    if (DiffPanel.current) {
      DiffPanel.current._panel.reveal(vscode.ViewColumn.One);
      await DiffPanel.current._render(status);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'sgitDiffPanel',
      'SGit Diff',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    DiffPanel.current = new DiffPanel(panel);
    await DiffPanel.current._render(status);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    panel.onDidDispose(() => {
      DiffPanel.current = undefined;
      this._disposables.forEach(d => d.dispose());
    }, null, this._disposables);
  }

  private async _render(status: FileStatus): Promise<void> {
    const { xy, filepath, repoRoot } = status;
    const filename = path.basename(filepath);

    this._panel.title = `${filename}: HEAD ↔ ${xy[0] !== ' ' && xy[0] !== '?' ? 'Staged' : 'Working Tree'}`;

    try {
      const diffCmd = (xy[0] !== ' ' && xy[0] !== '?')
        ? `git diff --cached HEAD -- "${filepath}"`   // staged
        : `git diff HEAD -- "${filepath}"`;            // unstaged

      const diffOut = await run(diffCmd, repoRoot);

      if (!diffOut.trim()) {
        this._panel.webview.html = this._emptyHtml(filename);
        return;
      }

      const rows = parseDiff(diffOut);
      this._panel.webview.html = buildHtml(filepath, rows, xy);
    } catch (err) {
      this._panel.webview.html = this._errorHtml(String(err));
    }
  }

  private _emptyHtml(filename: string): string {
    return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;
      font-family:sans-serif;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)">
      <p>No changes detected in <strong>${esc(filename)}</strong></p></body></html>`;
  }

  private _errorHtml(msg: string): string {
    return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;
      font-family:sans-serif;color:#f14c4c;background:var(--vscode-editor-background)">
      <p>Error: ${esc(msg)}</p></body></html>`;
  }
}

// ─── Shell helper ─────────────────────────────────────────────────────────────

function run(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(cmd, { cwd, maxBuffer: 20 * 1024 * 1024 }, (err, out) => {
      if (err) { reject(err); } else { resolve(out); }
    });
  });
}

// ─── Open diff ────────────────────────────────────────────────────────────────

async function openDiff(status: FileStatus): Promise<void> {
  await DiffPanel.createOrShow(status);
}

// ─── Tree item ────────────────────────────────────────────────────────────────

class SGitItem extends vscode.TreeItem {
  children?: SGitItem[];
  readonly kind: GroupKind | 'file';
  readonly fileStatus?: FileStatus;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    kind: GroupKind | 'file',
    opts: {
      icon?: string;
      description?: string;
      tooltip?: string;
      command?: vscode.Command;
      resourceUri?: vscode.Uri;
      children?: SGitItem[];
      fileStatus?: FileStatus;
    } = {}
  ) {
    super(label, collapsibleState);
    this.kind        = kind;
    this.description = opts.description;
    this.tooltip     = opts.tooltip;
    this.command     = opts.command;
    this.resourceUri = opts.resourceUri;
    this.children    = opts.children;
    this.fileStatus  = opts.fileStatus;
    if (kind === 'file') { this.contextValue = 'file'; }
    if (opts.icon) { this.iconPath = new vscode.ThemeIcon(opts.icon); }
  }

  static message(text: string, icon = 'info'): SGitItem {
    return new SGitItem(text, vscode.TreeItemCollapsibleState.None, 'message', { icon });
  }
}

// ─── Tree data provider ───────────────────────────────────────────────────────

class SGitProvider implements vscode.TreeDataProvider<SGitItem> {
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  refresh(): void { this._onChange.fire(); }
  getTreeItem(element: SGitItem): vscode.TreeItem { return element; }

  async getChildren(element?: SGitItem): Promise<SGitItem[]> {
    if (element) { return element.children ?? []; }
    return this.buildRoot();
  }

  private async buildRoot(): Promise<SGitItem[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return [SGitItem.message('No workspace open')]; }

    const roots = await this.findRepoRoots(folders.map(f => f.uri.fsPath));
    if (roots.length === 0) { return [SGitItem.message('No git repositories found')]; }
    if (roots.length === 1) { return this.buildGroupsForRepo(roots[0]); }
    return Promise.all(roots.map(r => this.buildRepoNode(r)));
  }

  private async buildRepoNode(repoRoot: string): Promise<SGitItem> {
    const groups       = await this.buildGroupsForRepo(repoRoot);
    const totalChanges = groups.reduce((n, g) => n + (g.children?.length ?? 0), 0);
    const repoName     = path.basename(repoRoot);

    return new SGitItem(repoName, vscode.TreeItemCollapsibleState.Expanded, 'repo', {
      icon: 'repo',
      description: totalChanges ? `${totalChanges} change${totalChanges !== 1 ? 's' : ''}` : 'clean',
      children: groups.length ? groups : [SGitItem.message('No changes', 'check')],
    });
  }

  private async buildGroupsForRepo(repoRoot: string): Promise<SGitItem[]> {
    const changes = await this.getStatus(repoRoot);
    const tracked = changes.filter(c => c.xy !== '??' && c.xy !== '!!');

    if (tracked.length === 0) { return [SGitItem.message('No changes', 'check')]; }

    const staged   = tracked.filter(c => c.xy[0] !== ' ');
    const unstaged = tracked.filter(c => c.xy[1] !== ' ' && c.xy[0] === ' ');
    const groups: SGitItem[] = [];

    if (staged.length)   { groups.push(this.buildGroup('Staged Changes', staged,   repoRoot, 'staged',  'pass')); }
    if (unstaged.length) { groups.push(this.buildGroup('Changes',        unstaged, repoRoot, 'changes', 'edit')); }

    return groups;
  }

  private buildGroup(title: string, statuses: FileStatus[], repoRoot: string, kind: GroupKind, icon: string): SGitItem {
    const children = statuses.map(s => this.buildFileItem(s, repoRoot));
    return new SGitItem(title, vscode.TreeItemCollapsibleState.Expanded, kind, {
      icon, description: `${statuses.length}`, children,
    });
  }

  private buildFileItem(status: FileStatus, repoRoot: string): SGitItem {
    const filename    = path.basename(status.filepath);
    const dir         = path.dirname(status.filepath);
    const fileUri     = vscode.Uri.file(path.join(repoRoot, status.filepath));
    const label       = status.origPath ? `${path.basename(status.origPath)} → ${filename}` : filename;
    const description = dir !== '.' ? dir : undefined;
    const tooltip     = `${status.filepath}\n${statusLabel(status.xy)}\nDouble-click to open diff`;

    return new SGitItem(label, vscode.TreeItemCollapsibleState.None, 'file', {
      icon: statusIcon(status.xy),
      description,
      tooltip,
      resourceUri: fileUri,
      fileStatus: { ...status, repoRoot },
      command: {
        command: 'sgit.handleFileClick',
        title: 'Open',
        arguments: [{ ...status, repoRoot }],
      },
    });
  }

  private async findRepoRoots(folders: string[]): Promise<string[]> {
    const roots: string[] = [];
    for (const folder of folders) {
      const root = await this.gitRoot(folder);
      if (root && !roots.includes(root)) { roots.push(root); }
    }
    return roots;
  }

  private gitRoot(cwd: string): Promise<string | null> {
    return new Promise(resolve => {
      cp.exec('git rev-parse --show-toplevel', { cwd }, (err, out) =>
        resolve(err ? null : out.trim())
      );
    });
  }

  private getStatus(repoRoot: string): Promise<FileStatus[]> {
    return new Promise(resolve => {
      cp.exec('git status --porcelain -uall', { cwd: repoRoot }, (err, out) => {
        if (err) { resolve([]); return; }
        const changes: FileStatus[] = [];
        for (const raw of out.split('\n')) {
          if (raw.length < 3) { continue; }
          const xy  = raw.slice(0, 2);
          let rest  = raw.slice(3);
          if (rest.startsWith('"') && rest.endsWith('"')) { rest = rest.slice(1, -1); }
          let filepath = rest;
          let origPath: string | undefined;
          const arrow = rest.indexOf(' -> ');
          if (arrow !== -1) {
            origPath = rest.slice(0, arrow).replace(/^"|"$/g, '');
            filepath = rest.slice(arrow + 4).replace(/^"|"$/g, '');
          }
          changes.push({ xy, filepath, origPath, repoRoot });
        }
        resolve(changes);
      });
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusLabel(xy: string): string {
  const map: Record<string, string> = {
    'M ': 'Staged modified',  'A ': 'Staged added',   'D ': 'Staged deleted',
    'R ': 'Staged renamed',   'C ': 'Staged copied',
    ' M': 'Modified',         ' D': 'Deleted',         'MM': 'Staged & modified',
    'DD': 'Unmerged — both deleted',
    'AA': 'Unmerged — both added',
    'UU': 'Unmerged — both modified',
  };
  return map[xy] ?? `Changed (${xy})`;
}

function statusIcon(xy: string): string {
  const x = xy[0], y = xy[1];
  if (x === 'A')              { return 'diff-added'; }
  if (x === 'D' || y === 'D') { return 'diff-removed'; }
  if (x === 'R' || x === 'C') { return 'diff-renamed'; }
  return 'diff-modified';
}

// ─── Activation ───────────────────────────────────────────────────────────────

const DOUBLE_CLICK_MS = 400;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SGitProvider();

  const view = vscode.window.createTreeView('sgitChangedFiles', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // Double-click detection (command fires on every click)
  const clickTracker = new Map<string, number>();

  const handleClickCmd = vscode.commands.registerCommand(
    'sgit.handleFileClick',
    async (status: FileStatus) => {
      const id  = `${status.repoRoot}:${status.filepath}`;
      const now = Date.now();
      const last = clickTracker.get(id) ?? 0;

      if (now - last < DOUBLE_CLICK_MS) {
        clickTracker.delete(id);
        await openDiff(status);
      } else {
        clickTracker.set(id, now);
      }
    }
  );

  const refreshCmd = vscode.commands.registerCommand('sgit.refresh', () => provider.refresh());

  const openDiffCmd = vscode.commands.registerCommand('sgit.openDiff', async (item?: SGitItem) => {
    const status = item?.fileStatus ?? view.selection[0]?.fileStatus;
    if (status) { await openDiff(status); }
  });

  const openFileCmd = vscode.commands.registerCommand('sgit.openFile', async (item?: SGitItem) => {
    const status = item?.fileStatus ?? view.selection[0]?.fileStatus;
    if (status) {
      await vscode.commands.executeCommand(
        'vscode.open', vscode.Uri.file(path.join(status.repoRoot, status.filepath))
      );
    }
  });

  const gitWatcher = vscode.workspace.createFileSystemWatcher(
    '**/.git/{index,HEAD,COMMIT_EDITMSG,ORIG_HEAD}'
  );
  gitWatcher.onDidChange(() => provider.refresh());
  gitWatcher.onDidCreate(() => provider.refresh());
  gitWatcher.onDidDelete(() => provider.refresh());

  const onSave = vscode.workspace.onDidSaveTextDocument(() => provider.refresh());

  context.subscriptions.push(
    view, handleClickCmd, refreshCmd, openDiffCmd, openFileCmd, gitWatcher, onSave
  );
}

export function deactivate(): void {}
