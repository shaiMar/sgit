import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ─── Data types ───────────────────────────────────────────────────────────────

interface FileStatus {
  xy: string;
  filepath: string;
  origPath?: string;
  repoRoot: string;
}

type GroupKind = 'staged' | 'changes' | 'message' | 'repo';

// ─── Beyond Compare launcher ──────────────────────────────────────────────────

const BC_CANDIDATES = [
  '/usr/local/bin/bcomp',
  '/usr/bin/bcomp',
  '/Applications/Beyond Compare.app/Contents/MacOS/bcomp',
  '/Applications/Beyond Compare 5.app/Contents/MacOS/bcomp',
  '/Applications/Beyond Compare 4.app/Contents/MacOS/bcomp',
];

function findBeyondCompare(): string | null {
  for (const p of BC_CANDIDATES) {
    if (fs.existsSync(p)) { return p; }
  }
  return null;
}

async function openInBeyondCompare(status: FileStatus): Promise<void> {
  const bcomp = findBeyondCompare();
  if (!bcomp) {
    vscode.window.showErrorMessage(
      'Beyond Compare not found. Install it and make sure `bcomp` is available at one of: ' +
      BC_CANDIDATES.join(', ')
    );
    return;
  }

  const { xy, filepath, repoRoot } = status;
  const filename  = path.basename(filepath);
  const isStaged  = xy[0] !== ' ' && xy[0] !== '?';
  const workingFile = path.join(repoRoot, filepath);

  // Save HEAD content to a temp file so Beyond Compare can open it
  const headContent = await gitShow(repoRoot, isStaged ? `:${filepath}` : `HEAD:${filepath}`);
  const tmpFile     = path.join(os.tmpdir(), `sgit_HEAD_${filename}`);
  fs.writeFileSync(tmpFile, headContent);

  // Beyond Compare: left = HEAD (or index), right = working tree
  cp.spawn(bcomp, [tmpFile, workingFile], { detached: true, stdio: 'ignore' }).unref();
}

function run(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(cmd, { cwd, maxBuffer: 5 * 1024 * 1024 }, (err, out) =>
      err ? reject(err) : resolve(out)
    );
  });
}

function findRepoRoot(filePath: string): Promise<string | null> {
  const dir = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
  return new Promise(resolve => {
    cp.exec('git rev-parse --show-toplevel', { cwd: dir }, (err, out) =>
      resolve(err ? null : out.trim())
    );
  });
}

function getFileXY(repoRoot: string, relative: string): Promise<string | null> {
  return new Promise(resolve => {
    cp.exec(`git status --porcelain -- "${relative}"`, { cwd: repoRoot }, (err, out) => {
      if (err || !out.trim()) { resolve(null); return; }
      resolve(out.slice(0, 2));   // first two chars are the XY code
    });
  });
}

function gitShow(repoRoot: string, ref: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(`git show "${ref}"`, { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024 }, (err, out) =>
      err ? reject(err) : resolve(out)
    );
  });
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
    return new SGitItem(path.basename(repoRoot), vscode.TreeItemCollapsibleState.Expanded, 'repo', {
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
    return new SGitItem(title, vscode.TreeItemCollapsibleState.Expanded, kind, {
      icon, description: `${statuses.length}`,
      children: statuses.map(s => this.buildFileItem(s, repoRoot)),
    });
  }

  private buildFileItem(status: FileStatus, repoRoot: string): SGitItem {
    const filename = path.basename(status.filepath);
    const dir      = path.dirname(status.filepath);
    const fileUri  = vscode.Uri.file(path.join(repoRoot, status.filepath));
    const label    = status.origPath ? `${path.basename(status.origPath)} → ${filename}` : filename;

    return new SGitItem(label, vscode.TreeItemCollapsibleState.None, 'file', {
      icon: statusIcon(status.xy),
      description: dir !== '.' ? dir : undefined,
      tooltip: `${status.filepath}\n${statusLabel(status.xy)}\nDouble-click to open in Beyond Compare`,
      resourceUri: fileUri,
      fileStatus: { ...status, repoRoot },
      command: { command: 'sgit.handleFileClick', title: 'Open', arguments: [{ ...status, repoRoot }] },
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

  // Double-click detection
  const clickTracker = new Map<string, number>();
  const handleClickCmd = vscode.commands.registerCommand(
    'sgit.handleFileClick',
    async (status: FileStatus) => {
      const id   = `${status.repoRoot}:${status.filepath}`;
      const now  = Date.now();
      const last = clickTracker.get(id) ?? 0;
      if (now - last < DOUBLE_CLICK_MS) {
        clickTracker.delete(id);
        await openInBeyondCompare(status);
      } else {
        clickTracker.set(id, now);
      }
    }
  );

  const refreshCmd  = vscode.commands.registerCommand('sgit.refresh', () => provider.refresh());

  // Right-click in Explorer → Open in Beyond Compare
  const openDiffExplorerCmd = vscode.commands.registerCommand(
    'sgit.openDiffExplorer',
    async (uri: vscode.Uri) => {
      if (!uri) { return; }
      const filePath  = uri.fsPath;
      const repoRoot  = await findRepoRoot(filePath);
      if (!repoRoot) {
        vscode.window.showErrorMessage('SGit: file is not inside a git repository.');
        return;
      }
      const relative = path.relative(repoRoot, filePath).replace(/\\/g, '/');
      // Detect git status for this specific file
      const xy = await getFileXY(repoRoot, relative);
      if (!xy) {
        vscode.window.showInformationMessage('SGit: no git changes detected for this file.');
        return;
      }
      await openInBeyondCompare({ xy, filepath: relative, repoRoot });
    }
  );

  // Explorer right-click → SGit → Diff with... (branch picker)
  const diffWithBranchCmd = vscode.commands.registerCommand(
    'sgit.diffWithBranch',
    async (uri: vscode.Uri) => {
      if (!uri) { return; }
      const filePath = uri.fsPath;
      const repoRoot = await findRepoRoot(filePath);
      if (!repoRoot) {
        vscode.window.showErrorMessage('SGit: file is not inside a git repository.');
        return;
      }

      const bcomp = findBeyondCompare();
      if (!bcomp) {
        vscode.window.showErrorMessage('SGit: Beyond Compare not found.');
        return;
      }

      // Fetch all local + remote branches sorted by most recent
      const branchOut = await run(
        'git branch -a --format="%(refname:short)" --sort=-committerdate',
        repoRoot
      ).catch(() => '');

      const branches = branchOut.trim().split('\n').filter(Boolean);
      if (!branches.length) {
        vscode.window.showErrorMessage('SGit: no branches found.');
        return;
      }

      const pick = await vscode.window.showQuickPick(branches, {
        title: 'SGit — Diff with branch',
        placeHolder: `Select a branch to compare against ${path.basename(filePath)}`,
        matchOnDescription: true,
      });
      if (!pick) { return; }

      const relative = path.relative(repoRoot, filePath).replace(/\\/g, '/');
      const branchContent = await gitShow(repoRoot, `${pick}:${relative}`).catch(() => '');
      const tmpFile = path.join(
        os.tmpdir(),
        `sgit_${pick.replace(/[\\/]/g, '_')}_${path.basename(filePath)}`
      );
      fs.writeFileSync(tmpFile, branchContent);

      cp.spawn(bcomp, [tmpFile, filePath], { detached: true, stdio: 'ignore' }).unref();
    }
  );

  const openDiffCmd = vscode.commands.registerCommand('sgit.openDiff', async (item?: SGitItem) => {
    const s = item?.fileStatus ?? view.selection[0]?.fileStatus;
    if (s) { await openInBeyondCompare(s); }
  });

  const openFileCmd = vscode.commands.registerCommand('sgit.openFile', async (item?: SGitItem) => {
    const s = item?.fileStatus ?? view.selection[0]?.fileStatus;
    if (s) {
      await vscode.commands.executeCommand('vscode.open',
        vscode.Uri.file(path.join(s.repoRoot, s.filepath)));
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
    view, handleClickCmd, refreshCmd, diffWithBranchCmd, openDiffCmd, openFileCmd, openDiffExplorerCmd, gitWatcher, onSave
  );
}

export function deactivate(): void {}
