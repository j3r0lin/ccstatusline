# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is a personal fork. Merge finished changes into `main` and push without asking first.

## Project Overview

ccstatusline is a customizable status line formatter for Claude Code CLI that displays model info, git branch, token usage, and other metrics. It functions as both:
1. A piped command processor for Claude Code status lines
2. An interactive TUI configuration tool when run without input

## Development Commands

```bash
# Install dependencies
bun install

# Run in interactive TUI mode
bun run start

# Test with piped input (use [1m] suffix for 1M context models)
echo '{"model":{"id":"claude-sonnet-4-5-20250929[1m]"},"transcript_path":"test.jsonl"}' | bun run src/ccstatusline.ts

# Or use example payload
bun run example

# Build for npm distribution
bun run build   # Creates dist/ccstatusline.js with Node.js 14+ compatibility

# Run tests (from a Claude Code session, unset the gateway variables it exports, or ~36 tests fail)
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN bun test

# Run tests in watch mode
bun test --watch

# Lint and type check
bun run lint      # Runs TypeScript type checking and ESLint without modifying files

# Apply ESLint auto-fixes intentionally
bun run lint:fix
```

## Local Development vs. Published Builds

ccstatusline can be run directly from source during local development; compiling to `dist/` is only required for npm distribution or when invoking the globally installed `ccstatusline` binary.

- **Local development / testing**: use `bun run src/ccstatusline.ts` or `bun run start`. Bun executes TypeScript directly, so source changes take effect immediately without `bun run build`.
- **Claude Code using local changes**: the status-line command in Claude Code settings must point to the local source path, e.g. `bun run /path/to/ccstatusline/src/ccstatusline.ts`. Commands like `npx -y ccstatusline@latest`, `bunx -y ccstatusline@latest`, or a global `ccstatusline` use the published npm package instead and will not reflect local source edits until a new version is published and installed.
- **Claude Code using a Bun-compiled standalone binary**: if `settings.json` points to a compiled executable such as `~/.local/bin/ccstatusline` (produced by `bun build --compile`), source changes do **not** take effect until you recompile and replace that executable:
  ```bash
  bun build --compile --outfile=/tmp/ccstatusline-new src/ccstatusline.ts
  cp ~/.local/bin/ccstatusline ~/.local/bin/ccstatusline.bak.$(date +%Y%m%d)
  cp /tmp/ccstatusline-new ~/.local/bin/ccstatusline
  chmod +x ~/.local/bin/ccstatusline
  ```
- **Publishing / distribution**: run `bun run build` to produce `dist/ccstatusline.js`. The npm package's `bin` entry and `files` array both reference `dist/ccstatusline.js`, and `prepublishOnly` runs the build automatically.
- **Project convention**: After a feature is implemented and verified, deliver it to `~/.local/bin/ccstatusline` by compiling and replacing the standalone binary (see the steps above). Do this automatically unless the user explicitly asks otherwise.
- **Build the binary from a checkout of `main`**: the repo root checkout is shared with other sessions and may be sitting on a feature branch they left there, so confirm with `git branch --show-current` before compiling, and build from a worktree at `main` when it isn't.

## Architecture

Runs on both Bun and Node.js.

- `src/ccstatusline.ts` — entry point; piped JSON renders a status line, no stdin launches the TUI
- `src/tui/` — React/Ink configuration UI
- `src/utils/` — settings, rendering, colors, git, usage fetching, powerline
- `src/widgets/` — one file per widget

Settings live at `~/.config/ccstatusline/settings.json`; Claude Code integration honors `CLAUDE_CONFIG_DIR`.

Widgets implement the interface in `src/types/Widget.ts` and register in the map in `src/utils/widgets.ts` — read both before adding one.

Kimi's monthly pool is not in Kimi's own `/coding/v1/usages` reply. A local Surge script (`~/.config/magpie/surge/kimi-monthly.js`, setup in the README beside it) appends it as a 30-day `TIME_UNIT_DAY` entry in `limits`, and `kimi-usage.ts` reads that entry. So the monthly value appears only when the request goes through Surge: the status-line command sets `HTTPS_PROXY=http://127.0.0.1:6152`, and `NODE_EXTRA_CA_CERTS` points at the exported Surge CA, because the Bun binary does not trust the macOS keychain. Without that CA the request fails with `SELF_SIGNED_CERT_IN_CHAIN`. Keep the monthly window absent rather than erroring when the entry is missing.

Optional widget methods include `getHideableStates()`, `supportsNumberFormat()`, and `preservesRenderedColors()`.

## Conventions

- Use `bun <file>`, `bun install`, `bun run <script>`, `bun build` instead of the Node equivalents. Bun loads `.env` on its own.
- Run checks with `bun run lint`; use `bun run lint:fix` only when you want the auto-fixes. Never invoke `npx eslint`, `eslint`, `tsx`, or `bun tsc` directly.
- Never disable a lint rule with a comment.
- Print rendered status lines as-is so the user sees real colors; to read the SGR codes yourself, make that a separate run (`cat -v` also mangles non-ASCII text into escapes).
- `patches/ink@<version>.patch` maps `\x7f` back to backspace on macOS and is applied by `bun install` via `patchedDependencies` — carry it forward when bumping ink.
