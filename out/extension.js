"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const path = __importStar(require("path"));
// ─── Tree item ────────────────────────────────────────────────────────────────
class SGitItem extends vscode.TreeItem {
    constructor(label, collapsibleState, kind, opts = {}) {
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
    static message(text, icon = 'info') {
        return new SGitItem(text, vscode.TreeItemCollapsibleState.None, 'message', { icon });
    }
}
// ─── Tree data provider ───────────────────────────────────────────────────────
class SGitProvider {
    constructor() {
        this._onChange = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onChange.event;
    }
    refresh() {
        this._onChange.fire();
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        if (element) {
            return element.children ?? [];
        }
        return this.buildRoot();
    }
    // ── Root ──────────────────────────────────────────────────────────────────
    async buildRoot() {
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
    async buildRepoNode(repoRoot) {
        const groups = await this.buildGroupsForRepo(repoRoot);
        const totalChanges = groups.reduce((n, g) => n + (g.children?.length ?? 0), 0);
        const repoName = path.basename(repoRoot);
        const node = new SGitItem(repoName, vscode.TreeItemCollapsibleState.Expanded, 'repo', {
            icon: 'repo',
            description: totalChanges ? `${totalChanges} change${totalChanges !== 1 ? 's' : ''}` : 'clean',
            children: groups.length ? groups : [SGitItem.message('No changes', 'check')],
        });
        return node;
    }
    async buildGroupsForRepo(repoRoot) {
        const changes = await this.getStatus(repoRoot);
        if (changes.length === 0) {
            return [SGitItem.message('No changes', 'check')];
        }
        const staged = changes.filter(c => c.xy[0] !== ' ' && c.xy[0] !== '?' && c.xy[0] !== '!');
        const unstaged = changes.filter(c => c.xy[1] !== ' ' && c.xy[1] !== '?' && c.xy[0] === ' ');
        const untracked = changes.filter(c => c.xy === '??');
        const groups = [];
        if (staged.length)
            groups.push(this.buildGroup('Staged Changes', staged, repoRoot, 'staged', 'pass'));
        if (unstaged.length)
            groups.push(this.buildGroup('Changes', unstaged, repoRoot, 'changes', 'edit'));
        if (untracked.length)
            groups.push(this.buildGroup('Untracked Files', untracked, repoRoot, 'untracked', 'question'));
        return groups;
    }
    buildGroup(title, statuses, repoRoot, kind, icon) {
        const children = statuses.map(s => this.buildFileItem(s, repoRoot));
        return new SGitItem(title, vscode.TreeItemCollapsibleState.Expanded, kind, { icon, description: `${statuses.length}`, children });
    }
    buildFileItem(status, repoRoot) {
        const filename = path.basename(status.filepath);
        const dir = path.dirname(status.filepath);
        const fileUri = vscode.Uri.file(path.join(repoRoot, status.filepath));
        const label = status.origPath
            ? `${path.basename(status.origPath)} → ${filename}`
            : filename;
        const description = dir !== '.' ? dir : undefined;
        const tooltip = `${status.filepath}\n${statusLabel(status.xy)}`;
        const icon = statusIcon(status.xy);
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
    async findRepoRoots(folders) {
        const roots = [];
        for (const folder of folders) {
            const root = await this.gitRoot(folder);
            if (root && !roots.includes(root)) {
                roots.push(root);
            }
        }
        return roots;
    }
    gitRoot(cwd) {
        return new Promise(resolve => {
            cp.exec('git rev-parse --show-toplevel', { cwd }, (err, out) => resolve(err ? null : out.trim()));
        });
    }
    getStatus(repoRoot) {
        return new Promise(resolve => {
            cp.exec('git status --porcelain -uall', { cwd: repoRoot }, (err, out) => {
                if (err) {
                    resolve([]);
                    return;
                }
                const changes = [];
                for (const raw of out.split('\n')) {
                    if (raw.length < 3) {
                        continue;
                    }
                    const xy = raw.slice(0, 2);
                    let rest = raw.slice(3);
                    // Strip surrounding quotes (paths with spaces)
                    if (rest.startsWith('"') && rest.endsWith('"')) {
                        rest = rest.slice(1, -1);
                    }
                    let filepath = rest;
                    let origPath;
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
function statusLabel(xy) {
    const map = {
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
function statusIcon(xy) {
    const x = xy[0], y = xy[1];
    if (xy === '??') {
        return 'diff-added';
    }
    if (x === 'A') {
        return 'diff-added';
    }
    if (x === 'D' || y === 'D') {
        return 'diff-removed';
    }
    if (x === 'R' || x === 'C') {
        return 'diff-renamed';
    }
    return 'diff-modified';
}
// ─── Activation ───────────────────────────────────────────────────────────────
function activate(context) {
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
function deactivate() { }
//# sourceMappingURL=extension.js.map