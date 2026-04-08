<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->

# t012: Phase 8 — Docs, .distignore, readme updates

**Session origin:** `opencode:interactive:2026-04-07` (Phase 8 of [p001](../PLANS.md))
**Issue:** [Ultimate-Multisite/ultimate-ai-connector-webllm#12](https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm/issues/12)
**Tier:** `tier:simple`
**Status:** `status:blocked` (waiting on t011)
**Estimate:** ~2h
**Auto-dispatch:** yes (once unblocked)
**Parent plan:** [p001](../PLANS.md) — Phase 8 of 8
**Blocks:** none (final phase)
**Blocked-by:** t011

## What

Update all user-facing docs to describe the new zero-config SharedWorker runtime as the primary path and the dedicated tab as the fallback. Bump version, update changelog, ensure `.distignore` still correctly excludes dev files.

## How

### Files to modify

**EDIT:** `README.md` — primary user-facing doc; replace the "Open Tools → WebLLM Worker" flow with the new zero-config flow
**EDIT:** `readme.txt` — WordPress.org metadata; add changelog entry and bump `Stable tag`
**EDIT:** `ultimate-ai-connector-webllm.php` header — bump `Version:` from 1.0.2 to 1.1.0 (new minor because this is a major user-facing change but additive)
**EDIT:** `AGENTS.md` — update "Architecture" section diagram with the new SharedWorker flow
**EDIT:** `.distignore` — verify `src/`, tests, config files are excluded; add anything new that shouldn't ship in the archive
**EDIT:** `composer.json` → `archive.exclude` — keep in sync with `.distignore`

### Reference pattern

- Existing `README.md` structure is the template — keep the same sections, update content
- `readme.txt` uses WordPress.org plugin format (`== Description ==`, `== Changelog ==`, etc.)
- Version bump pattern: look at how 1.0.1 → 1.0.2 was handled in git history

### Changelog entry

Add to `readme.txt` under `== Changelog ==`:

```text
= 1.1.0 =
* NEW: Zero-config SharedWorker runtime — the LLM survives page navigation and shows a small floating icon in the corner of admin pages. No more keeping a dedicated worker tab open.
* NEW: Auto-detected recommended model based on hardware capabilities.
* NEW: apiFetch middleware intercepts AI requests from WordPress/ai experiments and shows a friendly start modal when the model isn't loaded yet.
* NEW: Settings panel for the runtime mode (auto / shared-worker / dedicated-tab / disabled).
* NEW: Hooks into `wpai_preferred_text_models` filter so AI Experiments (WordPress/ai plugin) actually routes through WebLLM when configured.
* FALLBACK: Older browsers without SharedWorker + WebGPU support automatically fall back to the existing Tools → WebLLM Worker (Manual mode) page.
* REQUIRES: Chrome 124+ or Edge 124+ for the SharedWorker runtime. Older browsers use the fallback.
```

### README updates

Replace the "Quick start" section with:

```markdown
## Quick start

1. Install and activate the plugin on WordPress 7.0+.
2. Visit any wp-admin page. A small floating icon appears in the corner.
3. The first time you click an AI feature (e.g. the excerpt generator in WordPress/ai), a start modal appears showing the recommended model for your hardware. Click **Start**.
4. Wait for the model to download (once per browser — cached in IndexedDB after that).
5. Done. Every AI feature in WordPress is now served by your browser's GPU.

The model stays loaded as you navigate between admin pages and between posts. Closing the last wp-admin tab frees the GPU memory. Reopening wp-admin reloads the model from cache in a few seconds.

### Browser support

- **Chrome 124+, Edge 124+ (desktop)** — full SharedWorker runtime, zero-config
- **Older Chromium / Firefox / Safari** — fall back to the classic "Tools → WebLLM Worker (Manual mode)" page

### Cross-device usage

Because the WordPress site brokers requests, any logged-in device on the install can use the desktop's GPU. Open WP admin on your phone, click Generate excerpt, and the request is served by the SharedWorker in your desktop Chrome tab.
```

### AGENTS.md architecture diagram

Replace the existing ASCII diagram with:

```text
PHP AI Client SDK ──▶ WebLlmProvider / WebLlmModel
                       │  POST /wp-json/webllm/v1/chat/completions
                       ▼
             REST broker (inc/rest-api.php)
                       │ enqueue job, long-poll
                       │
           ┌───────────┴───────────┐
           ▼                       ▼
     SharedWorker              Dedicated tab
     (Chrome 124+,             (fallback for older
      every admin              browsers and manual
      tab shares one)          override)
           │                       │
           │  Both run              │
           │  @mlc-ai/web-llm       │
           │  on WebGPU             │
           ▼                       ▼
       GPU inference → POST /jobs/{id}/result → broker → SDK
```

### .distignore review

Ensure these are excluded from the release archive:

```
src/
node_modules/
tests/
todo/
.git/
.github/
.distignore
.idea
.vscode
.phpunit.result.cache
.DS_Store
phpunit.xml.dist
phpcs.xml.dist
webpack.config.js
package.json
package-lock.json
composer.lock
TODO.md
AGENTS.md
.agents/
.aidevops.json
```

The `composer.json → archive.exclude` list must match. Keep them in sync.

### Gotchas

1. **Version bump is 1.1.0, not 1.0.3.** This is a user-facing feature addition, not a bugfix.
2. **Don't break WordPress.org readme.txt format** — it has strict parsing rules (e.g. `== Section ==` headers, `= Subsection =` sub-headers).
3. **Screenshots from t011** should be referenced in the README and/or readme.txt `== Screenshots ==` section if committed.
4. **Don't ship `.agents/` or `.aidevops.json` in the release archive.** They're dev-only and leak internal workflow info. Already excluded via `.distignore` but verify.

## Acceptance criteria

1. `README.md`, `readme.txt`, `AGENTS.md`, `ultimate-ai-connector-webllm.php` version header, `.distignore`, `composer.json` all updated consistently.
2. `composer archive` produces a clean zip that does NOT contain `src/`, `tests/`, `todo/`, `.git/`, `node_modules/`, `AGENTS.md`, `.agents/`, `.aidevops.json`, or any dev-only config files. Verify with `unzip -l ultimate-ai-connector-webllm.zip`.
3. Reading `README.md` end-to-end makes clear how a new user should use the plugin, without needing to look at any code.
4. `composer test` and `npm run build` both pass.
5. Diff is scoped to documentation files — no PHP or JS logic changes.

## Verification commands

```bash
composer archive
unzip -l ultimate-ai-connector-webllm.zip | grep -E "src/|tests/|todo/|AGENTS|\.agents" && echo "LEAK" || echo "clean"
composer test
npm run build
# Manual: read README.md as a new user; verify it answers their first 5 likely questions
```

## Context

- Depends on: all of t006-t011 merged and tested
- Final phase of [p001](../PLANS.md)
- PRD reference: [prd-shared-worker-runtime.md](prd-shared-worker-runtime.md) → "Modified files" and "Definition of done"
