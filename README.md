# SGit

A VS Code / Cursor extension that adds a sidebar panel showing all **tracked git-changed files**, grouped by status — similar to running `git status` but always visible in the activity bar.

---

## Features

- **Activity bar icon** — click the SGit icon in the left sidebar to open the panel
- **Live file list** — shows staged changes and unstaged changes, auto-refreshes on save and git events
- **Double-click** a file in the panel → opens it in **Beyond Compare** (HEAD vs working tree)
- **Right-click** a file in the panel → context menu with:
  - Open Diff (Beyond Compare vs HEAD)
  - Open File
- **Right-click any file in the Explorer** → **SGit** submenu:
  - **Diff with...** — pick any local or remote branch from a dropdown, opens Beyond Compare
  - **Diff with HEAD** — opens Beyond Compare comparing HEAD vs working tree
- **Manual refresh** button (↺) in the panel title bar

---

## File groups

| Group | What's shown |
|---|---|
| **Staged Changes** | Files added to the git index (`git add`) |
| **Changes** | Tracked files modified in the working tree |

Untracked (`??`) and ignored (`!!`) files are excluded.

---

## Requirements

- **Git** must be available in `PATH`
- **Beyond Compare** must be installed with `bcomp` accessible at one of:
  - `/usr/local/bin/bcomp`
  - `/usr/bin/bcomp`
  - `/Applications/Beyond Compare.app/Contents/MacOS/bcomp`
  - `/Applications/Beyond Compare 4.app/Contents/MacOS/bcomp`
  - `/Applications/Beyond Compare 5.app/Contents/MacOS/bcomp`

---

## Installation

### Run in development (F5)

```bash
git clone git@github.com:shaiMar/sgit.git
cd sgit
npm install
```

Open the folder in VS Code / Cursor and press **F5** to launch the Extension Development Host.

### Install permanently

```bash
git clone git@github.com:shaiMar/sgit.git
cd sgit
npm install

# Build a .vsix installable package
npm run pack
# → produces sgit-0.1.0.vsix in the project root

# OR: build + install into Cursor in one step
npm run install-ext
# → runs pack, then: cursor --install-extension sgit-0.1.0.vsix
```

After installing, reload the window (`Cmd+Shift+P` → `Reload Window`).

### Scripts reference

| Script | What it does |
|---|---|
| `npm run compile` | One-time TypeScript compile |
| `npm run watch` | Continuous TypeScript compile (used with F5) |
| `npm run pack` | Package into `sgit-0.1.0.vsix` |
| `npm run install-ext` | Pack **and** install into Cursor |

---

## Project structure

```
sgit/
├── src/
│   └── extension.ts      # all extension logic
├── resources/
│   └── sgit-icon.svg     # activity bar icon
├── .vscode/
│   ├── launch.json       # F5 debug config
│   ├── tasks.json        # TypeScript watch task
│   └── settings.json     # workspace settings
├── context.md            # project context / architecture notes
├── package.json
└── tsconfig.json
```

---

## License

MIT
