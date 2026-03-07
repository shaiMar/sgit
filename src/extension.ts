import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

// ─── Data types ───────────────────────────────────────────────────────────────

interface FileStatus {
  /** Two-char XY porcelain code, e.g. " M", "A ", "??" */
  xy: string;
  filepath: string;
  origPath?: string;
  repoRoot: string;
}

type GroupKind = 'staged' | 'changes' | 'untracked' | 'message' | 'repo';

// ─── Tree item ────────────────────────────────────────────────────────────────

class SGitItem extends vscode.TreeItem {
  children?: SGitItem[];
  readonly kind: GroupKind | 'file';

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
    } = {}
  ) {
    super(label, collapsibleState);
    this.kind = kind;
    this.description = opts.description;
    this.tooltip = opts.tooltip;
    this.command = opts.command;
    this.resourceUri = opts.resourceUri;
    this.children = opts.children;
    if (opts.icon) {
      this.iconPath = new vscode.ThemeIcon(opts.icon);
    }
  }

  static message(text: string, icon = 'info'): SGitItem {
    return new SGitItem(text, vscode.TreeItemCollapsibleState.None, 'message', { icon });
  }
}

// ─── Tree data provider ───────────────────────────────────────────────────────

class SGitProvider implements vscode.TreeDataProvider<SGitItem> {
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  refresh(): void {
    this._onChange.fire();
  }

  getTreeItem(element: SGitItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SGitItem): Promise<SGitItem[]> {
    if (element) {
      return element.children ?? [];
    }
    return this.buildRoot();
  }

  // ── Root ──────────────────────────────────────────────────────────────────

  private async buildRoot(): Promise<SGitItem[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      return [SGitItem.message('No workspace open')];
    }

    const roots = await this.findRepoRoots(folders.map(f => f.uri.fsPath));
    if (roots.length === 0) {
      return [SGitItem.message('No git repositories found')];
    }

    if (roots.length === 1) {
      return this.buildGroupsForRepo(roots[0]);
    }

    // Multiple repos → one collapsible node per repo
    return Promise.all(roots.map(r => this.buildRepoNode(r)));
  }

  private async buildRepoNode(repoRoot: string): Promise<SGitItem> {
    const groups = await this.buildGroupsForRepo(repoRoot);
    const totalChanges = groups.reduce((n, g) => n + (g.children?.length ?? 0), 0);
    const repoName = path.basename(repoRoot);

    const node = new SGitItem(
      repoName,
      vscode.TreeItemCollapsibleState.Expanded,
      'repo',
      {
        icon: 'repo',
        description: totalChanges ? `${totalChanges} change${totalChanges !== 1 ? 's' : ''}` : 'clean',
        children: groups.length ? groups : [SGitItem.message('No changes', 'check')],
      }
    );
    return node;
  }

  private async buildGroupsForRepo(repoRoot: string): Promise<SGitItem[]> {
    const changes = await this.getStatus(repoRoot);

    if (changes.length === 0) {
      return [SGitItem.message('No changes', 'check')];
    }

    const staged    = changes.filter(c => c.xy[0] !== ' ' && c.xy[0] !== '?' && c.xy[0] !== '!');
    const unstaged  = changes.filter(c => c.xy[1] !== ' ' && c.xy[1] !== '?' && c.xy[0] === ' ');
    const untracked = changes.filter(c => c.xy === '??');

    const groups: SGitItem[] = [];

    if (staged.length)    groups.push(this.buildGroup('Staged Changes',  staged,    repoRoot, 'staged',    'pass'));
    if (unstaged.length)  groups.push(this.buildGroup('Changes',         unstaged,  repoRoot, 'changes',   'edit'));
    if (untracked.length) groups.push(this.buildGroup('Untracked Files', untracked, repoRoot, 'untracked', 'question'));

    return groups;
  }

  private buildGroup(
    title: string,
    statuses: FileStatus[],
    repoRoot: string,
    kind: GroupKind,
    icon: string
  ): SGitItem {
    const children = statuses.map(s => this.buildFileItem(s, repoRoot));
    return new SGitItem(
      title,
      vscode.TreeItemCollapsibleState.Expanded,
      kind,
      { icon, description: `${statuses.length}`, children }
    );
  }

  private buildFileItem(status: FileStatus, repoRoot: string): SGitItem {
    const filename = path.basename(status.filepath);
    const dir      = path.dirname(status.filepath);
    const fileUri  = vscode.Uri.file(path.join(repoRoot, status.filepath));

    const label       = status.origPath
      ? `${path.basename(status.origPath)} → ${filename}`
      : filename;
    const description = dir !== '.' ? dir : undefined;
    const tooltip     = `${status.filepath}\n${statusLabel(status.xy)}`;
    const icon        = statusIcon(status.xy);

    return new SGitItem(label, vscode.TreeItemCollapsibleState.None, 'file', {
      icon,
      description,
      tooltip,
      resourceUri: fileUri,
      command: {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [fileUri],
      },
    });
  }

  // ── Git helpers ───────────────────────────────────────────────────────────

  private async findRepoRoots(folders: string[]): Promise<string[]> {
    const roots: string[] = [];
    for (const folder of folders) {
      const root = await this.gitRoot(folder);
      if (root && !roots.includes(root)) {
        roots.push(root);
      }
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

          const xy   = raw.slice(0, 2);
          let rest   = raw.slice(3);

          // Strip surrounding quotes (paths with spaces)
          if (rest.startsWith('"') && rest.endsWith('"')) {
            rest = rest.slice(1, -1);
          }

          let filepath = rest;
          let origPath: string | undefined;

          // Renames: "old -> new"
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
    'M ': 'Staged modified',
    'A ': 'Staged added',
    'D ': 'Staged deleted',
    'R ': 'Staged renamed',
    'C ': 'Staged copied',
    ' M': 'Modified',
    ' D': 'Deleted',
    'MM': 'Staged & modified',
    '??': 'Untracked',
    '!!': 'Ignored',
    'DD': 'Unmerged (both deleted)',
    'AA': 'Unmerged (both added)',
    'UU': 'Unmerged (both modified)',
  };
  return map[xy] ?? `Changed (${xy})`;
}

function statusIcon(xy: string): string {
  const x = xy[0], y = xy[1];
  if (xy === '??') { return 'diff-added'; }
  if (x === 'A')   { return 'diff-added'; }
  if (x === 'D' || y === 'D') { return 'diff-removed'; }
  if (x === 'R' || x === 'C') { return 'diff-renamed'; }
  return 'diff-modified';
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SGitProvider();

  const view = vscode.window.createTreeView('sgitChangedFiles', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // Refresh command (button in view title bar)
  const refreshCmd = vscode.commands.registerCommand('sgit.refresh', () => provider.refresh());

  // Auto-refresh when git index / HEAD changes (covers commits, staging, checkouts)
  const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git/{index,HEAD,COMMIT_EDITMSG,ORIG_HEAD}');
  gitWatcher.onDidChange(() => provider.refresh());
  gitWatcher.onDidCreate(() => provider.refresh());
  gitWatcher.onDidDelete(() => provider.refresh());

  // Also refresh on file save (covers unstaged edits)
  const onSave = vscode.workspace.onDidSaveTextDocument(() => provider.refresh());

  context.subscriptions.push(view, refreshCmd, gitWatcher, onSave);
}

export function deactivate(): void {}
