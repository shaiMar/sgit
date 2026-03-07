# SGit

A VS Code / Cursor extension that adds a sidebar panel showing all **tracked git-changed files**, grouped by status — similar to running `git status` but always visible in the activity bar.

---

## Features

- **Activity bar icon** — click the SGit icon in the left sidebar to open the panel
- **Live file list** — shows staged changes and unstaged changes, auto-refreshes on save and git events
- **Double-click** a file → opens it in **Beyond Compare** (HEAD vs working tree)
- **Right-click** a file → context menu with:
  - Open Diff (Beyond Compare)
  - Open File
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
npm install

# Build the .vsix package
npm run pack

# Build + install into Cursor in one step
npm run install-ext
```

Then reload the window (`Cmd+Shift+P` → `Reload Window`).

---
shai
Remote: `git@github.com:shaiMar/sgit.git`

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
