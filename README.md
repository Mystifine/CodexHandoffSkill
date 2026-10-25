# codex-handoff

A Claude Code skill for delegating decided implementation work to the local Codex CLI. Claude writes the brief and reviews the result; Codex does the execution. Setup lives here; ordinary execution uses SKILL.md without modifying the installation.

## One-time installation

Prerequisites: Claude Code, Git, Node.js 18+, and Bash. On Windows use **Git Bash**, including for the commands below. WSL Bash uses a separate environment and is not the supported Windows launcher.

1. Install and authenticate Codex first:

   ```bash
   npm install -g @openai/codex
   codex login
   codex --version
   ```

2. Install the skill and its Claude permission rules:

   ```bash
   git clone https://github.com/Mystifine/CodexHandoffSkill.git ~/.claude/skills/codex-handoff
   node ~/.claude/skills/codex-handoff/scripts/install.mjs
   bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --check
   ```

   If that destination already exists, update the existing installation instead of cloning over it. The installer merges rules into `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR/settings.json`), preserves unrelated settings and the permission mode, and can be rerun safely. Invalid JSON is left unchanged. It adds the wrapper's Bash permission and auto-mode classifier rule; it does not enable `bypassPermissions` or switch Claude into auto mode. Existing deny rules or managed policy may still require administrator/user action. Inspect installed rules with `/permissions`.

3. For proactive routing, optionally add this once to `~/.claude/CLAUDE.md`:

   ```markdown
   Use ~/.claude/skills/codex-handoff/SKILL.md for substantial decided implementation, UI construction from a spec, images, Blender/animation, and bulk mechanical work. Claude decides and reviews; do small edits directly when delegation costs as much. Load the skill before the first handoff.
   ```

4. Configure needed MCP servers once in Codex, using `codex mcp` or Codex's config files. Check them with `codex mcp list --json`. Claude integrations and skills are not automatically copied into Codex. Enable relevant skills/apps in Codex separately.

**Default execution is unsandboxed:** the wrapper selects `danger-full-access`. This avoids the Windows sandbox setup path that has shown file-lock failures during concurrent Codex use on this machine. It does not fix that sandbox or guarantee every environment will work. For a sandbox, set `CODEX_HANDOFF_SANDBOX=workspace-write` or pass `--sandbox workspace-write`; failures are reported, never silently retried with broader access. Worktree and resource locks coordinate cooperating handoffs; they are not filesystem access controls.

## Running and parallelism

```bash
bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --brief "/absolute/task.md" --cd "/absolute/project"
```

Claude runs that command in the background. Each launch, including resume, has its own run directory. The original brief is copied and left intact. Model and effort come from Codex config unless overridden with `--model` / `--effort` or `CODEX_HANDOFF_MODEL` / `CODEX_HANDOFF_EFFORT`.

One writable checkout is exclusive across handoffs, including nested directories and overlapping `--add-dir` roots. A conflicting launch returns **75 (busy)**. To work in parallel:

```bash
# Run these as separate background commands against a clean source checkout.
bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --brief "/tmp/task-a.md" --cd "/absolute/project" --worktree
bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --brief "/tmp/task-b.md" --cd "/absolute/project" --worktree
```

`--worktree` creates a distinct detached Git worktree from HEAD and prints its path. It requires a clean, idle source checkout. It does not copy ignored dependencies, local config, secrets, or uncommitted changes. For those inputs, prepare separate worktrees yourself and pass their paths with `--cd`. Review `changes.patch`, verify, and integrate each result into your intended branch. Worktrees remain until you explicitly remove them with `git worktree remove`; `--clean` never removes them. The wrapper never commits or pushes automatically.

MCP servers are **opt-in per invocation**. For example, add `--mcp blender` or `--mcp Roblox_Studio`; their tools are approved only for that invocation, and each server is locked across cooperating handoffs. All other effective CLI-configured MCP servers are disabled for that run. For aliases that reach the same app, supply a common `--resource blender` on every caller. Keep manual/other-agent access to that live app idle while a handoff uses it. Locks cannot control apps or processes launched outside this wrapper.

Resume with `--resume THREAD --cd "/original/worktree"`, repeating needed MCP/resource flags. A thread cannot be resumed concurrently, and a known thread cannot be moved to another checkout. Each resume still gets a distinct run directory. For an older/external thread whose directory is not recorded, the caller must supply its original checkout.

## Results and recovery

The wrapper requests a structured `result.json` alongside the human report. Exit 0 requires a completed turn and explicit task completion (or an exact readiness reply for `--check`). Missing/invalid results, snapshot failures, declared blockers, and detected sandbox/approval failures are unaccepted. Nonzero intermediate commands can be recovered during the same task; Claude still verifies the final result.

The review patch captures before/after Git trees, including content of already-untracked files, without changing the real index or stash. It includes any human/external edits made in that checkout during the run. Ignored files and writes outside the checkout are outside this snapshot. Review such authorized changes separately. This is review evidence, not proof of who authored each edit or that the task is correct.

| Exit | Meaning and next step |
|---|---|
| 0 | Completed or ready; review the result |
| 1 | Failed; inspect summary and relevant log tail |
| 2 | Usage-limited; wait until the recorded reset or use Claude |
| 3 | Timed out; inspect partial work before resuming |
| 4 | Blocked, cancelled, or needs review; inspect the report |
| 64 | Invalid arguments or incompatible checkout |
| 69 / 70 / 71 | CLI/config unavailable / not logged in / no usable model |
| 75 | Checkout, app, thread, or bookkeeping busy |

`--cancel "/run/directory"` requests cancellation from the owning supervisor, which stops its exact child process tree. There is no command-line wildcard process matching. If the supervisor was forcibly terminated while a child remains alive, the reservation stays busy; inspect its recorded native child PID before stopping it manually. Do not kill other Codex sessions to clear a lock. A dead bookkeeping-lock owner is recovered automatically; a lock recovery interrupted by a second crash may require inspecting the reported `.handoff.lock.reaper` file after confirming no operation is active.

Readiness probes are cached for 12 hours per configuration/CLI version. Model fallback is remembered for 24 hours and only retries explicit startup model errors before any tool execution; it never replays an already-started task. Set `CODEX_HANDOFF_FALLBACK_MODELS` to a comma-separated candidate list; otherwise the wrapper asks the CLI model catalog. `--check --probe` forces a fresh readiness probe. `--ignore-limit` explicitly retries a remembered usage limit; overlapping successful runs cannot erase one, and concurrent limit reports retain the latest reset.

## Files and maintenance

State lives in `~/.claude/codex-handoffs` (`CODEX_HANDOFF_HOME` override). Use the **same handoff home** across cooperating sessions so locks are shared. Repository paths are canonicalized and hashed to avoid same-name project collisions; worktrees from one repository share project notes and accounting. The printed project directory contains `templates/`, `LESSONS.md`, `ledger.tsv`, `tasks.tsv`, and unique run directories. Legacy project `LESSONS.md` is read when no new-path lessons exist; old accounting remains untouched.

Successful runs remove their raw event/stderr logs after saving a compact summary, task metadata, and patch. Unaccepted runs retain diagnostics. Finish review before `--clean THREAD [--claude-tokens N]`; cleanup refuses active threads, preserves worktrees, and records provided Claude usage without inventing measurements. Old completed run artifacts are pruned after three days on subsequent launches; active/unfinished runs and worktrees are preserved. Leave Codex's session history alone.

To update a Git-cloned global installation:

```bash
git -C ~/.claude/skills/codex-handoff pull --ff-only
node ~/.claude/skills/codex-handoff/scripts/install.mjs
bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --check
```

If you maintain a separate source repository (for example `Documents/CodexHandoffSkill`) and a copied global installation, edit and commit the source repository, then copy its `SKILL.md`, `README.md`, `scripts/`, and `references/` to the global installation. Do not copy `.git`, test output, or project-specific runtime state. Do not modify either installation during ordinary handoffs; propose maintenance separately.

Maintainer verification: `node --test`. The suite uses temporary repositories and a fake CLI to exercise simultaneous launches, worktree isolation, resource locks, usage-limit races, cancellation/timeout, status classification, installer merging, and review patches without consuming model usage or touching live apps. A prior single-panel UI experiment observed 40–47% fewer director tokens with exact specs; broader savings and parallel speedups are not established by that experiment.
