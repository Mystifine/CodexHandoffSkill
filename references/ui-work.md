# UI handoffs

Claude owns design; Codex constructs the decided screen. A component library alone is not a design spec.

- Specify colors, fonts, sizes, radii, strokes, spacing, and a wireframe per breakpoint. Define selected, empty, loading, error, disabled, and long-text states, animation values, API, and mock data.
- For a new style, Claude provides a small working style kit defining the distinctive builders. Codex composes it without restyling; later screens reuse it.
- Require an objective layout audit at every requested breakpoint and a contact sheet of key states. Review it against the spec, rerun the audit, and inspect one full-size phone view in the selected or longest-text state.
- Send one concrete fix brief listing defects and expected values. Review again; do not accept based only on Codex saying it checked screenshots.
- Roblox screens also use [roblox-ui.md](roblox-ui.md) and its layout audit.

The original UI experiment used one panel built four ways. Exact specs, especially with a working style kit, reduced revisions. Its observed token savings are not a general break-even rule; measure subsequent tasks with tasks.tsv.
