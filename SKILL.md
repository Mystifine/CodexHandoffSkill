---
name: codex-handoff
description: Delegate decided implementation work to the local Codex CLI to save Claude tokens. Use for substantial code changes, UI construction from a decided spec, images, Blender and animation work, or bulk mechanical edits; also for "hand off", "give it to Codex", or /codex-handoff. Claude decides and reviews.
---

# Codex handoff

Claude decides, directs and accepts; Codex executes a written brief in a separate session. Keep design, trade-offs, creative direction and acceptance with Claude; delegate execution once decided. Do small edits yourself when briefing plus review would cost as much. Outward actions (publishing, uploading, commit/push, purchases, deleting user files) need explicit user authorization written into the brief. Never edit this skill, settings, permissions or sandbox to repair a run; record project lessons in the handoff home.

`handoff.sh` below means `bash ~/.claude/skills/codex-handoff/scripts/handoff.sh`. Always call it in that exact form, with `--cd` instead of a `cd` prefix, since the installed permission matches it.

## 1. Check once per session

`handoff.sh --check` verifies install, login, remembered limits and a model reply (cached 12 h), and lists pending resumes; act on any that are ready.

Exits 69/70/71, or 2 before any run starts: tell the user briefly and do the work yourself. 75: busy; do independent work, retry after the owner finishes. 3/4: inspect, send a targeted follow-up, never claim acceptance. A limit hit mid-run: see §3.

## 2. Orient cheaply, then brief

- First do the project's CLAUDE.md/AGENTS.md start-of-task steps; this skill doesn't replace them. Orient only enough to decide; leave deep exploration to Codex.
- Point to paths and rules instead of pasting them. Codex reads AGENTS.md and standing lessons itself; the wrapper adds the report and result.json instructions.
- Confirm Codex has the skills and MCP servers it needs (Claude's aren't shared). Reuse approved templates from the project directory.
- Critical code (persistence, migrations, payments, validation, security, auth): write explicit invariants and test cases; review every changed line.
- Creative work: exact prompts, proportions, palette, beats, budgets, framing, transparency and paths; references via `--image`. UI: [UI work](references/ui-work.md); Roblox screens: [Roblox UI](references/roblox-ui.md). Copy generated image originals to deliverables, never move them. Blender: require asset/animation QA and review media.

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
## Phases         <work over ~45 min or several deliverables: numbered, independently verifiable>
```

Codex checkpoints after each phase, and resumes continue from the checkpoint.

## 3. Launch in the background

`handoff.sh --brief "<brief>" --cd "<checkout>" --note "<note>"` with `run_in_background: true`. The note (≤ 1500 chars) is the director context that survives `/clear`: review criteria, next steps, the user-authorized scope, and items pending on the user. Completion wakes you; don't poll.

- **Parallel:** separate prepared worktrees via `--cd`, or `--worktree` (detached from a clean checkout's HEAD; excludes uncommitted and ignored files). Integrate each, then remove its worktree yourself. Overlapping checkouts or `--add-dir` roots are refused.
- **Live apps:** `--mcp <server>` enables only that server, exclusive across handoffs; callers sharing a service also pass the same `--resource <name>`. Don't drive an app a handoff holds.
- **Sandbox:** the default `danger-full-access` is unsandboxed, and briefs aren't enforcement. Respect `CODEX_HANDOFF_SANDBOX`/`--sandbox`; never widen it.
- **Resume:** run the summary's `follow-up:` command with the follow-up brief (and an updated `--note` if needed). Never resume concurrently or with `--worktree`.
- **Other:** `--image FILE`, `--add-dir DIR` (repeatable); `--timeout-min N` (180); `--name SLUG`; `--model`/`--effort` only when the user asks. `--cancel "<run dir>"` stops the run's process tree; killing the shell may leave Codex running.

**Limit hit mid-run (exit 2 with a run directory): wait by default.** Start `handoff.sh --wait` with `run_in_background: true`, never a hand-written sleep. Tell the user the job is paused, when it resumes, and that the timer runs in the background; they can wait or ask you to finish. When the timer fires it prints each job's goal, checkpoint, note and exact resume command, even after `/clear`. Run that command unchanged; resuming the same brief within its recorded scope is already authorized, but anything new or outward still needs the user. If the user asks you to finish, stop the timer task, take over from the checkout and checkpoint, then follow §4.

## 4. Review and finish

COMPLETED needs a finished turn and a valid result.json claiming every requirement; acceptance is still yours. Missing results, infrastructure failures or missing review evidence mean unaccepted.

- **Code:** read `changes.patch` (every checkout edit during the run, including pre-existing untracked files; attribution not guaranteed; for large binary patches use the printed text-only diff), then run project verification. Review ignored files and permitted outside edits separately.
- **Visuals:** compare the contact sheet with the exact payload; open full-size views where needed. Codex saying it looked is not evidence.
- **Fix round:** brief concrete defects with expected results and resume. Same defect after two attempts: fix it yourself.
- **Integration:** after all accepted work is integrated (including your own edits), run the project's end-of-task steps once in the main checkout, unless the project assigns them to Codex.
- **Notes:** save reusable approved briefs in the project's `templates/`; add a one-line `LESSONS.md` rule for a demonstrated mistake.
- **Clean:** `handoff.sh --clean <thread>` after acceptance logs the task's Codex and Claude usage to `usage.tsv` and drops its run directories and pending resume, keeping worktrees. The Claude figure covers all session activity since the first run; mention any unrelated work when reporting savings. Delete only scratch you can attribute to the task.
- Tell the user what changed, how it was verified, and what remains.

Files live in `~/.claude/codex-handoffs` (`CODEX_HANDOFF_HOME`), one directory per project. Exit codes: 0 ok; 1 failed; 2 usage limit; 3 timeout; 4 blocked/cancelled/needs review; 64 arguments; 69 CLI/config; 70 login; 71 model; 75 busy. On failure read only the summary and relevant log tails.
