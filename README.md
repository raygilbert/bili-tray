# bili-tray

Menu bar app for the [billion-context proxy](https://github.com/ranxianglei/billion-context).

Shows a blue "b" icon in the macOS menu bar with controls to **Start / Stop / Restart** the bili proxy, view config, and read console output.

## Files

```
main.js          Electron tray application (single file)
package.json     Dependencies (Electron)
```

## Setup

```bash
cd bili-tray
npm install
```

## Usage

### Tray app

```bash
npx electron .                    # from the project directory
# or install the CLI helper:
cp bilitray ~/.local/bin/          # see below
```

### CLI wrapper

Install to your PATH (e.g. `~/.local/bin/bilitray`):

```bash
# Point it at your bili-tray source tree
export BILI_TRAY_DIR=~/path/to/bili-tray

# Or install permanently:
cp bilitray ~/.local/bin/bilitray
```

The CLI wrapper is machine-specific — edit its `TRAY_DIR` variable to point at your checkout.

```bash
bilitray                  # launch the tray app (default)
bilitray status           # check proxy status
bilitray start / stop     # terminal controls (mirrors the tray)
bilitray logs             # view proxy output
```

### Environment variables (optional overrides)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BILI_PATH` | `bili` (from `$PATH`) | Path to the bili binary |
| `PROXY_PORT` | `8787` | Proxy listen port |
| `BILI_TRAY_DIR` | `~/dev/bili-tray` | Location of this project (CLI only) |

## Security notes

- **No API keys are stored or transmitted** by the tray app itself. It spawns `bili start` and monitors it — no network calls from Electron.
- Sensitive environment variables (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, etc.) are **filtered out** before spawning bili, to prevent them from appearing in proxy logs.
- Proxy stdout/stderr is saved to `/tmp/bili-proxy-console.log` and **sanitized** before writing: common key/token patterns are redacted.
- The tray icon is generated from inline SVG — no external assets or requests.
- The "Open Config" menu opens the config **directory** (`~/.config/billion-context/`) rather than any specific file path.

## Building a DMG Installer

Builds a code-signed `.dmg` installer for distribution:

```bash
# Development-signed (runs locally, unsigned warning on other machines)
bash build.sh

# Production-signed + notarized (no warnings, installs silently)
APPLE_TEAM_ID=XXXXXXXXXX \
APPLE_ID=your@email.com \
APPLE_PASSWORD=app-specific-password \
bash build.sh
```

This produces `dist/bili-tray 1.0.0.dmg` (name includes version).

**Note:** The build produces an **Universal binary** (x86_64 + arm64) so the app runs natively on both Intel and Apple Silicon Macs. Code signing is done post-packaging via `codesign` directly. Electron-packager's `--osx-sign` integration has a bug with sub-option parsing, so the build packages unsigned and signs the `.app` ourselves.
