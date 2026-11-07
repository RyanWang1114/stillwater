# GitHub handoff

This folder contains the source for Stillwater. Preparing these files does not create a repository, push code, publish an app, or upload any diary data.

## Source and releases

Commit the app source, tests, documentation, package manifests, lockfile, and workflow. Do not commit the `release` folder, `node_modules`, a diary database, a backup, an exported entry, or a log. `.gitignore` starts with a root-level allowlist to keep newly dropped personal files out of Git by default.

Review the candidate files with `git status --short` and `git diff --cached --name-only` before each commit. Ignoring a file does not remove it from existing Git history, and `git add --force` bypasses ignore rules. If a personal file has already been committed, stop before uploading and remove it from the intended repository history.

The source folder is intended to become the repository root. Do not make the entire surrounding Codex workspace the repository. Choose the repository name, visibility, and project license before publishing it. No license has been assigned on your behalf.

## Windows workflow

The workflow at `.github/workflows/windows.yml` runs on Windows:

1. Pull requests install the exact locked dependencies and run the tests.
2. A manual **Run workflow** or a `v*` tag runs the same checks and builds the Windows app.
3. Executables and SHA-256 checksums appear in the workflow run's **Artifacts** section for 30 days.

The workflow has read-only repository permissions and never creates a GitHub Release. After reviewing a build, a release can be published separately if requested. Only the built executable and accompanying checksums belong in the download; the diary data folder never does.

The workflow follows the official [checkout](https://github.com/actions/checkout/blob/v6/README.md), [pnpm 11 setup](https://github.com/pnpm/setup/blob/v1/README.md), and [artifact upload](https://github.com/actions/upload-artifact/blob/v4/README.md) documentation. It explicitly installs from the lockfile and does not depend on a local machine's Node.js installation.

## Before distributing a build

Run `pnpm test` and `pnpm run build:win` on Windows. Verify the app opens, saves an entry, closes, and reopens the same entry. Confirm the packaged source contains only app code and assets. Use a temporary diary for this check so a sample entry or personal attachment never gets bundled.

The current builds are unsigned and have no automatic update service. Code signing, release publication, and updates are separate future decisions. The executable includes third-party runtime notices; preserve them when distributing an unpacked build.
