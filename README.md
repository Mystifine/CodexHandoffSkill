# codex-handoff (Claude Code skill)

Lets Claude Code act as director while the local Codex CLI does decided execution work: code, UI built from Claude's spec, images, 3D/Blender, animation and bulk chores. Claude writes the brief and reviews the result; Codex spends its own budget. `SKILL.md` is what Claude reads; this file is for people installing it.

## Install
```bash
git clone https://github.com/Mystifine/CodexHandoffSkill.git ~/.claude/skills/codex-handoff
bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --check
```
Claude Code discovers the skill automatically. Optionally add a line to your `~/.claude/CLAUDE.md` asking Claude to route work through it proactively.

## Requirements
- Claude Code, with this folder at `~/.claude/skills/codex-handoff/`.
- Codex CLI on PATH (`npm i -g @openai/codex`) and logged in (`codex login`).
- `bash` (on Windows, Git Bash, which Claude Code uses), `node` 18+, and `git` for change tracking.
- Optional: MCP servers (e.g. Roblox Studio, Blender) configured in `~/.codex/config.toml` or a project's `.codex/config.toml`; the wrapper auto-approves their tools for non-interactive runs.

## Setup
- The model and reasoning effort come from your Codex config (`model`, `model_reasoning_effort` in `~/.codex/config.toml`). Override per environment with `CODEX_HANDOFF_MODEL` / `CODEX_HANDOFF_EFFORT`.
- Working files live in `~/.claude/codex-handoffs/<project>/` (override: `CODEX_HANDOFF_HOME`): run dirs (auto-pruned after 3 days), `templates/`, `LESSONS.md` (rules Codex reads on every run), `ledger.tsv` (Codex tokens per run) and `tasks.tsv` (Claude vs Codex tokens per task).
- Model fallback: if the configured model is unavailable, the wrapper tries `CODEX_HANDOFF_FALLBACK_MODELS` (comma list) or the catalog from `codex debug models` in priority order, and remembers the working one for 24 h.
- Check readiness: `bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --check [--probe]`. Exit codes: 0 ready, 69 not installed, 70 not logged in, 71 no usable model, 2 usage-limited until the recorded reset. The model probe is cached 12 h; `--probe` forces it. When Codex is unusable, Claude simply does the work itself.

## Contents
- `SKILL.md`: when to hand off, who owns what, the brief template, launch/review/cleanup workflow.
- `references/roblox-ui.md`, `references/roblox-ui-audit.luau`: extra rules and an objective UI audit for Roblox UI work; ignored for other platforms.
- `scripts/handoff.sh` (wrapper), `summarize.mjs` (compact run summary, ledger, usage-limit memory), `cleanup.mjs` (cleanup and per-task token log).

## Evidence
The UI rules come from one panel built four ways (vague brief, exact spec, spec plus style kit, Claude alone). Only spec-driven handoffs reached production quality, saving the director roughly 40-47% of its tokens on that panel. Savings on code-only handoffs are an estimate; `tasks.tsv` exists to measure them.
