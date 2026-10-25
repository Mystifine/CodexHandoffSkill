---
name: codex-handoff
description: Delegate decided implementation work to the local Codex CLI to save Claude tokens. Use for substantial code changes, UI construction from a decided spec, images, Blender and animation work, or bulk mechanical edits; also for "hand off", "give it to Codex", or /codex-handoff. Claude decides and reviews.
---

# Codex handoff

Claude decides, directs and accepts; Codex executes a written brief in a separate session. Keep design, trade-offs, creative direction and acceptance with Claude; delegate implementation, images, modeling, animation and mechanical work once decided. Do small edits yourself when briefing plus review would cost as much. Outward actions (publishing, uploading, commit/push, purchases, deleting user files) need explicit user authorization written into the brief. Never edit this skill, settings, permissions or sandbox to repair a run; record project lessons in the handoff home.

## 1. Check once per session

`bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --check` verifies install, login, remembered limits and a model reply (cached 12 h). Model fallback happens only before tools run.

Exit 2/69/70/71: tell the user briefly and do the work yourself; don't retry until setup changes or the limit resets. 75: a resource is busy; do independent work, retry after its owner finishes. 3/4: inspect and send a targeted follow-up; never claim acceptance. `--check` also lists pending resumes; act on any that are ready.

**Waiting out a limit** (when the user chooses to wait): run `bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --wait` with `run_in_background: true`; never hand-write a sleep timer. When the limit resets it prints each paused job's goal, note, run directory and exact resume command, so the job continues even after `/clear`. Run that command unchanged: resuming the same brief within its recorded scope is already authorized. Anything new, and any outward action the brief doesn't authorize, still needs the user. Give every launch `--note "<after Codex: review criteria and next steps; user-authorized scope; items pending on the user>"` (≤ 1500 chars, compressed), because the note is all the director context that survives.

## 2. Orient cheaply, then brief

- Loading this skill does not replace the project's own instructions. First do CLAUDE.md/AGENTS.md start-of-task steps (such as a bounded index query), then orient only enough to decide; leave deep exploration to Codex.
- Point to paths and rules; don't paste files or restate them. Codex reads AGENTS.md and standing lessons itself, and the wrapper appends report/result.json instructions.
- Confirm needed skills and MCP servers exist for Codex (Claude's are not shared). Reuse approved templates from the printed project directory.
- Critical code (persistence, migrations, payments, validation, security, auth): write explicit invariants and test cases; review every changed line.
- Creative work: exact prompts, proportions, palette, beats, budgets, framing, transparency and paths; attach references with `--image`. UI: read [UI work](references/ui-work.md); Roblox screens: [Roblox UI](references/roblox-ui.md). Generated images: copy originals to deliverables, never move them. Blender: require asset/animation QA and review media.

Write the brief to a unique scratch file; omit empty sections:

```markdown
# Task
## Goal
## Context        <working dir; relevant paths, references, decisions>
## Requirements   <observable behavior; exact spec or creative payload>
## Deliverables   <paths, formats, sizes, names>
## Constraints    <allowed edits; preserve; authorized outward actions or "none";
                   scratch in run dir; if ambiguity changes the decided design report blocked,
                   else choose conservatively and note it>
## Verification   <commands, invariants, QA; visual work: labeled contact sheet <= 1600 px>
```

## 3. Launch in the background

`bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --brief "<brief>" --cd "<checkout>"` with `run_in_background: true`. Keep exactly this form (the installed permission matches it); use `--cd`, not a shell prefix. Completion wakes you: prepare the next spec or review; don't poll.

- **Parallel code:** separate prepared worktrees via `--cd`, or `--worktree` (detached from a clean checkout's HEAD; excludes uncommitted and ignored inputs). Integrate each result, then remove its worktree explicitly. Concurrent writes to one checkout or overlapping `--add-dir` roots are refused.
- **Live apps:** `--mcp <server>` enables only that configured server, exclusive across handoffs; shared services also need the same `--resource <name>` on every caller. Don't drive an app a handoff holds.
- **Sandbox:** default `danger-full-access` is unsandboxed; briefs are not enforcement. Respect `CODEX_HANDOFF_SANDBOX`/`--sandbox`; never widen automatically. Windows sandbox setup errors report as blocked.
- **Resume:** the summary's `follow-up:` line is the complete command; swap in the follow-up brief (update `--note` if the next steps changed). Never resume concurrently or with `--worktree`.
- **Other:** repeatable `--image FILE` / `--add-dir DIR`; `--timeout-min N` (180); `--name SLUG`; `--model`/`--effort` (keep the user's engine unless asked). `--cancel "<run dir>"` stops a run's process tree; killing the shell alone may leave Codex running.

## 4. Review and finish

The summary shows status, thread, directory, usage, verification claim, changed files and review artifacts. COMPLETED needs a finished turn and a valid result.json claiming every requirement; you still decide acceptance. Missing results, infrastructure failures or missing review evidence mean unaccepted.

- **Code:** read `changes.patch` (every checkout edit during the run, tracked and pre-existing untracked; attribution not guaranteed), then run project verification. Ignored files and permitted outside edits need separate review.
- **Visuals:** compare the contact sheet with the exact payload; open full-size views where needed. Codex saying it looked is not evidence.
- **Fix round:** brief concrete defects with expected results and resume. Same defect after two attempts: fix it yourself.
- **Post-change steps:** after all accepted work is integrated (merges, fix rounds, your own edits), do the project's end-of-task steps from CLAUDE.md/AGENTS.md once in the main checkout, unless they assign them to Codex.
- **Notes:** save reusable approved briefs in the project directory's `templates/`; add a one-line rule to `LESSONS.md` for a demonstrated mistake.
- **Clean:** `bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --clean <thread> [--claude-tokens N]` (measured usage only). It preserves worktrees and refuses active threads. Delete only scratch positively attributed to the task.
- Tell the user what changed, how it was verified, and what remains.

Files live in `~/.claude/codex-handoffs` (`CODEX_HANDOFF_HOME`), per project keyed by canonical repo path; runs print the exact directory. Exit codes: 0 ok/ready; 1 failed; 2 usage limit; 3 timeout; 4 blocked/cancelled/needs review; 64 arguments; 69 CLI/config; 70 login; 71 model; 75 busy. On failure read only the summary and relevant log tails.
