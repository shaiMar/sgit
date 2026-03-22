# SGit — Project Context

## What it is
A VS Code extension that adds a sidebar panel showing all **tracked git-changed files**, grouped by status — similar to `git status` but always visible in the activity bar.

## Architecture

### Entry point
`src/extension.ts` — single file, activated on startup.

### Key classes / helpers
| Class / function | Role |
|---|---|
| `SGitProvider` | `TreeDataProvider` — builds and refreshes the file tree |
| `SGitItem` | `TreeItem` subclass — represents a repo, group, file, or message node |
| `sgitContentProvider` | `TextDocumentContentProvider` — serves git HEAD/Index content for the VS Code diff panel |
| `openDiffBranchVsFile` | Shared helper — given a branch name + relative path, opens BC or VS Code diff |
| `pickBranch` | Shared helper — shows a QuickPick of all branches sorted by recency |

### Tree structure
```
[repo name]          ← only shown when multiple repos in workspace
  Staged Changes     ← xy[0] !== ' '
    file.ts
  Changes            ← xy[1] !== ' ' and xy[0] === ' '
    file.ts
```
Untracked (`??`) and ignored (`!!`) files are excluded.

### Status codes
Uses git's two-character porcelain `XY` format:
- `X` = staged status, `Y` = unstaged status
- `' '` = unmodified in that slot

## Named panels / concepts
- **DP** — the side-by-side diff panel opened by double-clicking a file.
  - Staged file → HEAD vs Index (`git show :filepath`)
  - Unstaged file → HEAD vs Working Tree
  - Implemented via `vscode.commands.executeCommand('vscode.diff', ...)`
  - Left side uses the custom URI scheme `sgit-head://` served by `sgitContentProvider`

## Auto-refresh triggers
1. `.git/index`, `.git/HEAD`, `.git/COMMIT_EDITMSG`, `.git/ORIG_HEAD` change (covers stage/commit/checkout)
2. Any file save (`onDidSaveTextDocument`)
3. Manual refresh button (↺) in the panel title bar

## UX interactions
| Action | Result |
|---|---|
| Single-click file | Selects item (no action) |
| Double-click file | Opens **DP** (diff panel) |
| Right-click file → Open Diff | Opens **DP** |
| Right-click file → Open File | Opens file in editor |
| Explorer right-click file → SGit → Diff with... | Branch picker → Beyond Compare (file vs branch) |
| Explorer right-click file → SGit → Diff with HEAD | Beyond Compare (HEAD vs working tree) |
| Explorer right-click folder → SGit → Diff with... | Branch picker → persistent file list of changed files → click any to open Beyond Compare diff |

## Build & run
```bash
npm install          # install dev dependencies
npm run compile      # one-off build
npm run watch        # watch mode (used by F5 debug session)
```
Press **F5** in VS Code (with this folder open) to launch the Extension Development Host.

## SSH / Git remote
```bash
GIT_SSH_COMMAND='ssh -i ~/.ssh/wolf_2_ed25519_key -o IdentitiesOnly=yes' git push
```
Remote: `git@github.com:shaiMar/sgit.git`
