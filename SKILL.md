---
name: codex-handoff
description: Delegate decided implementation work to the local Codex CLI to save Claude tokens. Use for substantial code changes, UI construction from a decided spec, images, Blender and animation work, or bulk mechanical edits; also for "hand off", "give it to Codex", or /codex-handoff. Claude decides and reviews.
---

# Codex handoff

Claude directs and reviews; Codex executes a written brief in a separate session. Keep design, analysis, trade-offs, creative direction, and acceptance with Claude. Delegate implementation, images, modeling, animation, and mechanical work once the approach is decided. Do small edits yourself when briefing and review would cost as much as execution. Split mixed tasks at this boundary.

Installation is a one-time user action documented in README.md. During ordinary execution, use the installed wrapper; do not edit the skill, settings, permissions, or sandbox to repair a failed run. Record project lessons in the handoff home instead. Outward actions (publishing, uploading, commit/push, purchases, deleting user files) require explicit user authorization stated in the brief.

## 1. Check once per session

```bash
bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --check
```

This checks installation, login, remembered usage limits, and a model response (cached 12 hours per configuration). Launches check CLI/login/limits again. Model fallback is limited to pre-execution model failures; it never restarts a task after tools have begun.

For exit 2, 69, 70, or 71, tell the user briefly and do the work with Claude. Do not repeatedly retry until setup changes or the stated limit resets. Exit 75 means a resource is busy: continue independent work, then retry after its owner finishes. Exit 3 or 4 needs inspection and a targeted follow-up, not an acceptance claim.

## 2. Write a focused brief

Decide first. Point to relevant paths and project instructions rather than pasting files. Confirm needed skills and MCP servers exist in Codex; Claude's integrations are not automatically shared. Reuse approved templates from the project directory printed by earlier runs.

For persistence, migrations, payments, validation, security, or auth, write explicit invariants and test cases; review every changed line. For creative work, supply exact prompts, proportions, palette, animation beats, budgets, framing, transparency, and deliverable paths. Attach approved references with `--image`. Read [UI work](references/ui-work.md) for UI, and [Roblox UI](references/roblox-ui.md) for Roblox screens.

Write the brief to a unique scratch file:

```markdown
# Task
## Goal
<Concrete outcome.>
## Context
- Working directory: <absolute path>; follow its AGENTS.md.
- Relevant files, approved references, and decisions: <paths and values>.
## Requirements
1. <Observable behavior; exact creative payload or spec when relevant.>
## Deliverables
- <Paths, formats, dimensions, naming.>
## Constraints
- Allowed edits: <paths>. Preserve: <paths>.
- No publishing/uploading/commit/push/deleting user files/new dependencies unless authorized here: <none or exact authorization>.
- Keep scratch and review media in the run directory.
- If ambiguity changes the decided design, report it as blocked; otherwise choose a conservative detail and note it.
## Verification
- <Relevant commands, meaningful invariants, QA and expected results.>
- Visual work: <QA skill and labeled contact sheet, max 1600 px wide>.
## Report
Under 250 words: result, changed files, checks and outcomes, deviations, remaining review.
Also write the wrapper-requested result.json honestly; incomplete required checks mean blocked.
```

For generated images, copy originals to deliverable paths; leave originals for thread cleanup. Do not move them. Require the relevant asset/animation QA and review media for Blender work.

## 3. Launch in the background

```bash
bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --brief "<brief>" --cd "<checkout>"
```

Use `run_in_background: true`. Keep the wrapper as its own command in this form so the installed permission matches; use `--cd` instead of a shell prefix. Completion wakes Claude: work on the next spec, invariants, or review instead of polling logs.

- **Parallel code work:** use separate prepared worktrees with `--cd`, or add `--worktree` to create a detached worktree from a clean source checkout's HEAD. It excludes uncommitted and ignored inputs. Review and integrate each result before explicitly removing its worktree. Concurrent writes to one checkout or overlapping `--add-dir` roots are refused, even for disjoint files.
- **Live apps:** enable only needed configured servers, e.g. `--mcp blender` or `--mcp Roblox_Studio`. Other configured MCP servers are disabled for that invocation. Each enabled server is exclusive across handoffs. For aliases or shared services, also use the same `--resource <name>` on every caller. Do not drive that app yourself while delegated work holds it; external app sessions cannot be locked by the wrapper.
- **Sandbox:** default `danger-full-access` runs without a sandbox. A brief and review are instructions, not filesystem enforcement. Respect `CODEX_HANDOFF_SANDBOX` or `--sandbox`; never widen permissions automatically. Windows sandbox setup errors are reported as blocked. Separate worktrees prevent accidental checkout collisions but do not restrict an unsandboxed process.
- **Resume:** `--resume <thread> --cd "<original checkout>"` continues the conversation there. Repeat needed `--mcp`/`--resource` flags. Never resume one thread concurrently or use `--worktree` on a resume. Known thread-directory mismatches are refused.

Other options: repeatable `--image FILE` / `--add-dir DIR`; `--timeout-min N` (180 default); `--name SLUG`; `--model` / `--effort` (otherwise Codex config, with `CODEX_HANDOFF_MODEL` / `CODEX_HANDOFF_EFFORT` overrides). Keep the user's engine unless asked to change it. `--cancel "<run dir>"` asks its supervisor to stop its owned process tree; killing a background shell alone may leave Codex running.

## 4. Review and finish

The summary gives the task status, thread, working directory, usage, verification claim, changed files, and review artifacts. `COMPLETED` requires a completed turn and a valid `result.json` claiming all requirements were satisfied; Claude still checks acceptance. Missing results, infrastructure failures, and unavailable review evidence keep the run unaccepted.

- Code: inspect `changes.patch`, then run project verification. The patch captures tracked and pre-existing untracked content without changing the real index. It describes all checkout edits during the run, including human/external edits; attribution is not guaranteed. Ignored files and edits outside the checkout need separate review when permitted by the brief.
- Visuals: compare the contact sheet with the exact payload; inspect full-size views where needed. A model's claim to have inspected images is insufficient.
- Fix round: brief concrete defects with expected results and resume the thread. If the same defect survives two attempts, fix the remainder with Claude.
- Finish: save a reusable approved brief in the printed project directory's `templates/`; add a short rule to `LESSONS.md` for a demonstrated mistake. Keep these project notes outside the installed skill.
- Clean reviewed tasks: `bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --clean <thread> [--claude-tokens N]`. Use measured Claude usage if available; otherwise omit it. Cleanup preserves worktrees and refuses active threads. Delete only scratch files positively identified as created by the task; preserve other untracked files.
- Tell the user what changed, how it was verified, and any remaining work.

Working files live under `~/.claude/codex-handoffs` (`CODEX_HANDOFF_HOME` override), in project directories keyed by canonical repository path. Runs print the exact directory. Keep the same handoff home across cooperating sessions. Exit codes: 0 completed/ready; 1 failed; 2 usage limit; 3 timed out; 4 blocked/cancelled/needs review; 64 arguments; 69 CLI/config unavailable; 70 login; 71 model unavailable; 75 busy. Failed runs retain logs; open only the summary and relevant log tails when diagnosing.
