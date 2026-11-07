# Stillwater

A diary for Windows that keeps your writing on your computer. Stillwater opens in its own desktop window and works offline, with no account, analytics, or cloud service.

## Run the Windows app

Open `release/Stillwater-0.2.3-Windows-x64.exe` for the portable app, or run `release/Stillwater-0.2.3-Setup-x64.exe` to install it and create Windows shortcuts. Both include their runtime, so you do not need Node.js, a terminal, or a separately opened browser.

The `Start Stillwater.vbs` and `Start Stillwater.cmd` shortcuts in this source folder also open the built desktop executable. They require a completed build in `release/`.

The executable is the app; this source folder is for developing and building it. Windows builds are placed in `release/`. Development builds are unsigned, so Windows may show an unfamiliar-publisher warning.

## Write and find your entries

- Rich text, basic Markdown, automatic saving, draft recovery, and revision history.
- **Insert math**: searchable symbols, Greek letters, operators, arrows, fractions, and editable expression starters. Superscript/subscript work in both rich text and Markdown.
- Photos, file attachments, microphone voice notes, and sketches; up to 20 MB per attachment.
- Moods, tags, notebooks, favorites, full-text search, date filters, and a calendar.
- Writing prompts, built-in and custom templates, goals, streaks, and statistics.
- Pink-accented Paper, Sepia, and Midnight themes, adjustable writing fonts, and read/focus modes.
- Recoverable Trash, full JSON backups, text imports, and per-entry text, Markdown, HTML, and print/PDF export.

In **Insert math**, leave **Use LaTeX-style math** checked to typeset just the inserted expression. For example, `T(n) = aT(n/b) + O(n^d)` renders with mathematical letters and a superscript. Select existing text before opening Insert math to convert it, or double-click an inserted equation to edit its source. The rest of the diary keeps your chosen writing font. KaTeX and its fonts are bundled for offline use. Math source survives saving, backups, and Markdown (`\(...\)`) export; formatted HTML includes the fonts it needs.

Basic Markdown can simplify some rich formatting. Stillwater saves a revision before switching, so you can restore the rich version.

## Where your diary lives

The desktop app stores its SQLite database and attachments at:

```text
%APPDATA%\Stillwater\diary\diary.sqlite
```

Paste `%APPDATA%\Stillwater\diary` into File Explorer's address bar to find the folder. The database contains the entries, attachments, tags, notebooks, revisions, and settings. Replacing or moving the executable does not move this diary folder.

On the first launch, the app can migrate a detected database from the earlier browser version's `data` folder. It copies the diary into the desktop data folder and leaves the original in place. It never overwrites an existing desktop diary. You can also transfer writing using **Settings → Save full backup**, followed by **Import backup or text** in the desktop app. The two versions do not sync after migration.

Use the app's full-backup command while it is running. Copying only `diary.sqlite` while the app is open may miss changes in SQLite's companion files. Save backups outside the source and app folders. Importing a backup adds its entries and can produce duplicates if repeated.

There is currently **no password lock or encryption at rest**. Someone who can read your Windows files can read the diary. JSON backups and exported entries are also unencrypted. There is no cloud sync, automatic backup schedule, or background writing reminder. Trash stays recoverable until you explicitly delete it; it does not expire automatically.

## Develop and build

Use Windows x64, Node.js 24, and pnpm 11.25.0. The app's Electron and packaging versions are pinned in `package.json` and `pnpm-lock.yaml`.

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm start
pnpm run build:win
```

The initial dependency installation and build-tool downloads need internet access. The resulting desktop app runs offline. Tests use separate temporary databases; they do not use your personal diary.

The desktop window loads a private application scheme and accesses SQLite in the application process. It does not start a localhost web server. The optional `pnpm run start:web` command still runs the earlier browser version for development.

## Prepare for GitHub

Keep source and release files separate. `.gitignore` deliberately allows reviewed source paths and excludes diary databases, backups, exports, dependencies, executables, logs, and build output. The application package uses a separate source-file allowlist so a diary in the source folder is not bundled into a release.

The included Windows workflow tests pull requests. A manual run or a pushed `v*` tag also builds executables and saves them as downloadable workflow artifacts. It does **not** publish a GitHub Release. See [the GitHub handoff notes](docs/github.md) before uploading this project.

No project license has been selected. Third-party components retain their own licenses and notices.
