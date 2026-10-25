---
name: codex-handoff
description: Delegate decided execution work to the local Codex CLI to save Claude tokens, with Claude as director and reviewer. Use proactively for code changes beyond small edits, UI built from a Claude-written spec, image generation, 3D/Blender work, animation, and bulk mechanical work (boilerplate, pattern application, data entry, tests from a spec, verify-and-fix loops). Also when the user says "hand off", "give it to Codex" or /codex-handoff.
---

# Codex handoff

You (Claude) are the director: you decide, write the decision down, and approve every result. Codex is the crew: a capable junior that executes decided work in its own session on its own (cheaper, frequently reset) budget. A handoff is a brief, one background command and a review. Codex's output gets the same bar as your own work, because you answer for it.

## Who does what

| Work | Owner |
|---|---|
| Design and creative direction: features, architecture, art direction, image prompts, animation acting, player-facing copy | Claude |
| Analysis: root-cause debugging, trade-offs, planning, deciding the approach, code review | Claude |
| Code changes once the approach is decided: features, refactors, fixes, scripts, tests | Codex; Claude reviews the diff |
| Critical code: persistence and migrations, payments, server validation, security, auth | Codex implements against invariants and test cases Claude writes into the brief; Claude reviews every changed line |
| UI design: art direction, the exact spec, and a style kit for any new visual style | Claude (see UI work) |
| UI construction from that spec or kit: layout, breakpoints, states, data wiring, animation | Codex |
| Image generation; 3D modeling, Blender, rigging, export; animation and its renders | Codex, always |
| Bulk mechanical work: boilerplate, a decided pattern across files, renames, data/config from a spec, tests from a spec, lint/verify-and-fix loops, docs sync, batch asset processing | Codex |
| Edits where the brief would cost about as much as the edit; leftovers after one fix round | Claude |

Rules of thumb:
- Decide first, then hand off. If choices would still be made mid-task, make them in the brief.
- Break-even (estimate from one measured UI test): you spend about 23 tokens per line you write; a handoff adds about 3-7k (brief, fix brief, re-review). Do it yourself below roughly 150 lines of code or 300 lines of UI, or for a few obvious edits.
- Spend Codex tokens freely: thorough self-verification, extra checks and a resume round cost nothing that matters. Spend Claude tokens on deciding and reviewing.
- Don't do Codex's share yourself: no feature code a brief could carry, no image generation, no production modeling or animation. Read-only inspection is fine.
- Split mixed tasks. "Add a shop": Claude designs the data model, writes invariants and test cases, the UI spec and the icon prompts; Codex implements the service, builds the panel, generates icons and fills the catalog; Claude reviews.
- Outward-facing or irreversible actions (publishing, uploading, git commit/push, deleting user files, purchases) go in a brief only when the user explicitly asked in this conversation, and the brief states that authorization. Otherwise the brief forbids them.

## UI work (any platform)

Measured on one panel built four ways: a vague brief ("make UI that fits the game") never reached production quality, even after a fix round, and used the most Codex tokens; access to the project's UI library did not help. An exact spec reached production quality after one fix round. The spec plus a Claude-written style kit reached it on the first pass with the least review. Codex reported "screenshots reviewed" while text visibly overflowed.
- **Never hand off undecided UI.** A component library is not a design.
- **Claude writes the spec:** exact colors, fonts, sizes, radii, strokes, spacing; a wireframe per breakpoint; a states table (select, empty, loading, error, disabled, long text) with animation values; the API and mock data. Any unspecified value comes back wrong.
- **New visual style:** Claude also writes the style kit (the screen's distinctive builders) and checks it renders. Codex composes on it and must not restyle it; later screens reuse it.
- **Gate:** Codex self-checks with an objective audit at every breakpoint and delivers a contact sheet. You read the sheet against the spec, re-run the audit, and take one full-size screenshot at the phone breakpoint in the longest-text or selected state. One concrete fix round (each defect with its expected value), then fix leftovers yourself.
- **Roblox UI** (ScreenGuis, UI controllers): also read `references/roblox-ui.md` before writing the brief. Skip it for other platforms.

## Consistency
- **Write creative payloads verbatim:** exact image prompts (plus size, transparency, framing, variant count), animation beat tables, model specs (proportions, palette as hex, budgets), UI specs. Never brief "make it look good".
- **Anchor to the project's look:** cite its style docs and attach 1-3 approved assets with `--image`.
- **Reuse what worked:** save an approved brief to `<handoff home>/<project>/templates/<kind>.md` and start the next one of that kind from it.
- **Record lessons:** when you correct Codex or it repeats a mistake, add a one-line rule to `<handoff home>/<project>/LESSONS.md`. Codex reads it on every run in that project.
- Handoff home is `~/.claude/codex-handoffs` (override: `CODEX_HANDOFF_HOME`). Keep the engine fixed unless the user asks: the model and effort come from the user's Codex config.

## Workflow

### 0. Check availability (once per session, before the first brief)
`bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --check` takes seconds. It confirms Codex is installed and logged in, that no usage limit is active, and that a model answers. The model probe is cached for 12 h. If the configured model is unavailable, the wrapper falls back automatically to other Codex models (`CODEX_HANDOFF_FALLBACK_MODELS`, or the catalog in priority order) and remembers the one that works. Launches repeat these checks.

**When Codex is unusable** (exit 2 usage limit, 69 not installed, 70 not logged in, 71 no usable model), whether at the check or at a launch, continue as if this skill were not installed. Do the work yourself to your normal standard, tell the user in one line, and don't retry Codex until the next session or the reset time the message gives.

### 1. Prepare
Do the design and analysis first. Collect only what Codex needs: paths, the decided design, exact values. Point to files rather than pasting them; Codex reads the repo and its AGENTS.md. It has the same MCP servers (e.g. Blender, Roblox Studio) and skills, so name the skill to use. Start from a template when one exists.

### 2. Write the brief
Write it to your scratchpad or temp dir (it is moved into the run dir at launch). Drop sections that don't apply:

```markdown
# <Task title>
## Goal
<The outcome in one or two sentences.>
## Context
- Project: <absolute path>. Follow its AGENTS.md; skip session-start housekeeping unless needed.
- Relevant files: <path: why>
- Decided (do not revisit): <list>
## Creative payload / spec   (art, animation, image, UI)
<Verbatim prompts, beat table, model spec or UI spec. "Use exactly; do not reinterpret.">
## Requirements
1. <Concrete and checkable. Critical code: the invariants and test cases to implement.>
## Deliverables
- <Exact paths, sizes, formats, naming.>
## Constraints
- Do not modify: <paths>. No commit/push, publishing, uploading, deleting files you did not create, or new dependencies unless authorized here: <none>.
- If the spec is ambiguous, choose the most conservative option, note it, and continue.
- Keep scratch in the run directory; delete temporary files you created elsewhere.
## Verification (before finishing)
- <Commands; QA skill or audit to apply; 0-issue thresholds.>
## Review sheet   (visual tasks)
- One labeled contact sheet PNG in the run directory, at most 1600 px wide, showing <views/states>.
## Final report
Under 250 words: STATUS; files; verification results; deviations and decisions; what Claude must check. Longer detail in details.md in the run directory.
```
Images: Codex saves originals under `~/.codex/generated_images/<thread>/`; give destination paths and say "copy, do not move". Modeling and animation: require the QA skill and the review sheet.

### 3. Launch (background only)
```bash
bash ~/.claude/skills/codex-handoff/scripts/handoff.sh --brief "<brief>" --cd "<project root>"
```
Use `run_in_background: true`. The completion notification wakes you, so don't poll. While Codex works, do your share: the next spec, invariants, reviews.

Options: `--image <file>` (reference, repeatable) · `--add-dir <dir>` (extra writable dir) · `--resume <thread>` (follow-up in the same session; the brief is the follow-up) · `--cancel <run dir>` (stops Codex; killing the shell alone can leave it running) · `--sandbox danger-full-access` (only when `--add-dir` can't cover it) · `--timeout-min N` (default 180) · `--name <slug>` · `--model`/`--effort` (or `CODEX_HANDOFF_MODEL`/`CODEX_HANDOFF_EFFORT`) · `--ignore-limit`.

The wrapper auto-approves the tools of every MCP server in `~/.codex/config.toml` and the project's `.codex/config.toml`, since `codex exec` would otherwise reject them. Concurrency: parallel handoffs only on disjoint files; never two that use the same app (Blender, Studio), and don't drive that app yourself meanwhile.

### 4. Review (the acceptance gate)
The command prints a compact summary: status, thread, run dir, Codex tokens, repo changes (from a git snapshot), new files, MCP calls, generated images, review media, and the final report.
- Check each Requirement; pass only when all hold.
- Visuals: judge the contact sheet against the payload. Open single files only to settle a doubt.
- Code: use the `review diff` command from the summary (it diffs against the pre-run snapshot, so your own uncommitted work is excluded), then the project's verification. Never re-read whole files.
- Delete untracked files that aren't deliverables. Don't open `events.jsonl`/`stderr.log` unless the run failed, and then only tail or grep them.

### 5. Iterate or finish
- **Fix round:** a short follow-up brief listing only the defects, each with its expected result, run with `--resume <thread>`. If the same fix fails twice, do it yourself.
- **Finish:** save a repeatable brief to `templates/`, add lessons, then `handoff.sh --clean <thread> --claude-tokens <N>`. N is your tokens spent on this task (brief, reviews, fixes) if your context shows a token counter; omit the flag otherwise. It appends a Claude-vs-Codex row to `<project>/tasks.tsv` so savings can be measured. Clean abandoned tasks too.
- **Tell the user:** what went to Codex, how you verified it, what is open.

## Exit codes
`0` ok · `1` failed (summary, then `stderr.log`) · `2` usage limit (reset time recorded; later launches refuse until then) · `3` timed out (resume with "continue where you stopped") · `64` bad arguments · `69` Codex missing · `70` not logged in · `71` no usable model. For 2, 69, 70 and 71, Claude does the work itself (see step 0).
MCP calls failing inside Codex: open and connect the app, then resume. "Requires approval, but approval policy is never" means the server is missing from the Codex configs the wrapper reads (see `mcp_approve=` in the run's `invocation.txt`).

## Cleanup
Files that only let you and Codex communicate don't outlive the task. A successful run deletes its raw logs; a failed run keeps them. `--clean` removes the task's run dirs and generated-image originals. Every launch prunes run dirs older than 3 days. Each project keeps `templates/`, `LESSONS.md`, `ledger.tsv` (Codex usage per run) and `tasks.tsv` (per-task Claude vs Codex). Leave `~/.codex/sessions` alone.
