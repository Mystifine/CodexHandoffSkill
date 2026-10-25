#!/usr/bin/env bash
# Hand a written brief to the Codex CLI non-interactively and print a compact summary.
# Usage: handoff.sh --brief FILE [--cd DIR] [--resume THREAD_ID] [--image FILE]... [--add-dir DIR]...
#                   [--sandbox MODE] [--model M] [--effort E] [--timeout-min N] [--name SLUG] [--ignore-limit]
#        handoff.sh --check [--probe]   (installed, logged in, not usage-limited, and a working model?
#                                       The model probe is cached 12 h; --probe forces it.)
#        handoff.sh --cancel RUN_DIR    (stop the Codex process of a running handoff)
#        handoff.sh --clean THREAD_ID [--claude-tokens N]   (delete a finished task's run dirs and
#                                       image originals; optionally log Claude's tokens for the task)
# Exit: 0 ok, 1 failed, 2 Codex usage limit, 3 timed out, 64 bad arguments, 69 codex missing,
#       70 not logged in, 71 no usable model (configured model and fallbacks unavailable).
set -uo pipefail

# Model and effort default to the user's Codex config (~/.codex/config.toml); override per run or by env.
MODEL="${CODEX_HANDOFF_MODEL:-}"
EFFORT="${CODEX_HANDOFF_EFFORT:-}"
SANDBOX="workspace-write"
CWD="$PWD"
TIMEOUT_MIN=180
BRIEF=""
RESUME=""
NAME=""
CANCEL=""
CLEAN=""
PRUNE_DAYS=3
CHECK=""
PROBE=""
IGNORE_LIMIT=""
CLAUDE_TOKENS=""
IMAGES=()
ADD_DIRS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --brief) BRIEF="${2:-}"; shift 2 ;;
    --cd) CWD="${2:-}"; shift 2 ;;
    --resume) RESUME="${2:-}"; shift 2 ;;
    --image) IMAGES+=("${2:-}"); shift 2 ;;
    --add-dir) ADD_DIRS+=("${2:-}"); shift 2 ;;
    --sandbox) SANDBOX="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --effort) EFFORT="${2:-}"; shift 2 ;;
    --timeout-min) TIMEOUT_MIN="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --cancel) CANCEL="${2:-}"; shift 2 ;;
    --clean) CLEAN="${2:-}"; shift 2 ;;
    --claude-tokens) CLAUDE_TOKENS="${2:-}"; shift 2 ;;
    --check) CHECK=1; shift ;;
    --probe) PROBE=1; shift ;;
    --ignore-limit) IGNORE_LIMIT=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "handoff: unknown argument: $1" >&2; exit 64 ;;
  esac
done

# Codex is a native Windows binary: hand it C:/style paths, not /c/style ones.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# Stop Codex processes whose command line carries this run directory (it is in the prompt).
# Killing the npm shim alone can leave the native codex.exe running on Windows.
stop_run() {
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -in 'codex.exe','node.exe' -and \$_.CommandLine -like '*$1*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue; \$_.ProcessId }" | tr -d '\r'
  else
    pkill -f -- "$1" && echo "(pkill)"
  fi
}

if [ -n "$CANCEL" ]; then
  PIDS="$(stop_run "$(winpath "$CANCEL")" | tr '\n' ' ')"
  if [ -n "${PIDS// /}" ]; then echo "handoff: stopped Codex for $CANCEL (pids: $PIDS)"; else echo "handoff: no running Codex process for $CANCEL"; fi
  exit 0
fi

ROOT="${CODEX_HANDOFF_HOME:-$HOME/.claude/codex-handoffs}"
HERE="$(dirname "$0")"
if [ -n "$CLEAN" ]; then
  node "$HERE/cleanup.mjs" "$ROOT" --thread "$CLEAN" ${CLAUDE_TOKENS:+--claude-tokens "$CLAUDE_TOKENS"}
  exit $?
fi

# Preflight: fail in seconds, before a brief is wasted. A usage limit seen by an earlier run is
# remembered in $ROOT/.usage-limit (written by summarize.mjs) until its reset time.
preflight() {
  command -v codex >/dev/null 2>&1 || { echo "handoff: codex CLI is not on PATH (install: npm i -g @openai/codex)" >&2; return 69; }
  codex login status >/dev/null 2>&1 || { echo "handoff: Codex is not logged in (run: codex login)" >&2; return 70; }
  if [ -z "$IGNORE_LIMIT" ] && [ -f "$ROOT/.usage-limit" ]; then
    local until now
    until="$(sed -n 's/^until=//p' "$ROOT/.usage-limit")"
    now="$(date +%s)"
    if [ -n "$until" ] && [ "$now" -lt "$until" ]; then
      echo "handoff: Codex usage limit until $(date -d "@$until" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "$until") ($(( (until - now + 59) / 60 )) min). Do the work with Claude or wait; --ignore-limit to try anyway." >&2
      sed -n 's/^message=/handoff: last error: /p' "$ROOT/.usage-limit" >&2
      return 2
    fi
    rm -f "$ROOT/.usage-limit"
  fi
  return 0
}
# Model fallback. The model in the user's Codex config is tried first. If Codex reports it
# unavailable (model_not_found), up to 3 others are tried: CODEX_HANDOFF_FALLBACK_MODELS (comma
# list) or the visible models of `codex debug models` in priority order. A working fallback is
# remembered in $ROOT/.model-fallback for 24 h, after which the configured model is tried again.
CONFIG_MODEL="$(sed -n 's/^model[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$HOME/.codex/config.toml" 2>/dev/null | head -1)"
fresh() { # fresh <file> <max age s>: the file exists, matches the configured model, and is recent
  [ -f "$1" ] && [ "$(sed -n 's/^configured=//p' "$1")" = "$CONFIG_MODEL" ] \
    && [ $(( $(date +%s) - $(sed -n 's/^at=//p' "$1") )) -lt "$2" ]
}
fallback_models() { # prints untried candidates; $@ = models already tried
  local list m t skip
  if [ -n "${CODEX_HANDOFF_FALLBACK_MODELS:-}" ]; then
    list="$(printf '%s' "$CODEX_HANDOFF_FALLBACK_MODELS" | tr ',' ' ')"
  else
    list="$(codex debug models 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{(JSON.parse(s).models||[]).filter((m)=>m.visibility==="list").sort((a,b)=>(a.priority??99)-(b.priority??99)).forEach((m)=>console.log(m.slug))}catch{}})')"
  fi
  for m in $list; do
    skip=""
    for t in "$@"; do [ "$m" = "$t" ] && skip=1; done
    [ -z "$skip" ] && echo "$m"
  done
}
model_missing() { grep -q -E 'model_not_found|model is not supported|model .{0,60}does not exist|access to (the )?model' "$1/events.jsonl" "$1/stderr.log" 2>/dev/null; }
# run_with_fallback <dir> <codex args...>: sets CODE (codex exit) and USED (model; empty = config).
run_with_fallback() {
  local dir="$1" margs tried=() next
  shift
  USED="$MODEL"
  [ -z "$USED" ] && fresh "$ROOT/.model-fallback" 86400 && USED="$(sed -n 's/^model=//p' "$ROOT/.model-fallback")"
  while :; do
    margs=()
    [ -n "$USED" ] && margs=(-m "$USED")
    # stdin must be closed, or `codex exec` waits forever for "additional input".
    (cd "$CWD" && timeout --kill-after=30s "${TIMEOUT_MIN}m" codex "$@" ${margs[@]+"${margs[@]}"}) \
      < /dev/null > "$dir/events.jsonl" 2> "$dir/stderr.log"
    CODE=$?
    model_missing "$dir" || break
    tried+=("${USED:-$CONFIG_MODEL}")
    [ "${#tried[@]}" -le 3 ] || break
    next="$(fallback_models "${tried[@]}" | head -1)"
    [ -n "$next" ] || break
    echo "handoff: model ${USED:-$CONFIG_MODEL} is unavailable; retrying with $next" | tee -a "$dir/fallback.txt" >&2
    USED="$next"
  done
  printf '%s\n' "${USED:-${CONFIG_MODEL:-codex default}}" > "$dir/model.txt"
  if [ "${#tried[@]}" -gt 0 ] && ! model_missing "$dir"; then
    printf 'configured=%s\nmodel=%s\nat=%s\n' "$CONFIG_MODEL" "$USED" "$(date +%s)" > "$ROOT/.model-fallback"
  fi
}
# probe: a tiny read-only run proving a model answers; cached in $ROOT/.model-ok for 12 h.
probe() {
  local f="$ROOT/.model-ok" dir now status keep_cwd="$CWD" keep_timeout="$TIMEOUT_MIN"
  if [ -z "$PROBE" ] && fresh "$f" 43200; then PROBED="$(sed -n 's/^model=//p' "$f")"; return 0; fi
  dir="$ROOT/_probe/$(date +%Y%m%d-%H%M%S)-probe"
  mkdir -p "$dir" || return 1
  CWD="$dir"; TIMEOUT_MIN=3
  run_with_fallback "$dir" exec "Reply with exactly: OK" -s read-only --skip-git-repo-check --json \
    -o "$(winpath "$dir")/final.md" -c 'model_reasoning_effort="low"'
  CWD="$keep_cwd"; TIMEOUT_MIN="$keep_timeout"
  now="$(date +%s)"
  node "$HERE/summarize.mjs" "$dir" "$CODE" "$now" "$now" "" > "$ROOT/_probe/summary.txt"
  status=$?
  [ "$status" -ne 0 ] && grep -E '^(Codex handoff|usage limit|  )' "$ROOT/_probe/summary.txt" | head -4 >&2
  rm -rf "$ROOT/_probe"
  [ "$status" -eq 0 ] || return "$status"
  PROBED="${USED:-$CONFIG_MODEL}"
  printf 'configured=%s\nmodel=%s\nat=%s\n' "$CONFIG_MODEL" "$PROBED" "$now" > "$f"
}

preflight; PRE=$?
if [ -n "$CHECK" ]; then
  [ "$PRE" -eq 0 ] || exit "$PRE"
  probe; PRE=$?
  [ "$PRE" -eq 0 ] && echo "handoff: Codex ready ($(codex --version 2>/dev/null | head -1), model ${PROBED:-codex default})"
  [ "$PRE" -eq 71 ] && echo "handoff: no usable Codex model (configured: ${CONFIG_MODEL:-default}; fallbacks failed). Work with Claude alone." >&2
  exit $PRE
fi
[ "$PRE" -eq 0 ] || exit $PRE

[ -f "$BRIEF" ] || { echo "handoff: brief not found: '$BRIEF'" >&2; exit 64; }
case "$SANDBOX" in read-only|workspace-write|danger-full-access) ;; *) echo "handoff: bad --sandbox '$SANDBOX'" >&2; exit 64 ;; esac

CWD="$(cd "$CWD" 2>/dev/null && pwd)" || { echo "handoff: --cd directory not found" >&2; exit 64; }
CWD_W="$(winpath "$CWD")"
PROJECT="$(basename "$CWD")"

# `codex exec` runs with approval policy "never", which rejects MCP tool calls outright.
# Auto-approve the tools of every configured MCP server (Roblox Studio, Blender, ...);
# the sandbox and the rest of the approval policy stay as they are.
MCP_APPROVE=()
for name in $(cat "$HOME/.codex/config.toml" "$CWD/.codex/config.toml" 2>/dev/null \
    | tr -d '\r' | sed -n 's/^\[mcp_servers\.\([A-Za-z0-9_-]*\)\]$/\1/p' | sort -u); do
  MCP_APPROVE+=(-c "mcp_servers.$name.default_tools_approval_mode=\"approve\"")
done
[ -n "$NAME" ] || NAME="$(basename "$BRIEF")"
NAME="$(printf '%s' "${NAME%.*}" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-48)"
node "$HERE/cleanup.mjs" "$ROOT" --prune "$PRUNE_DAYS"
RUN="$ROOT/$PROJECT/$(date +%Y%m%d-%H%M%S)-$NAME"
mkdir -p "$RUN" || exit 1
RUN_W="$(winpath "$RUN")"

# A brief written in the temp/scratchpad area is moved, so no stray copy is left behind.
BRIEF_W="$(winpath "$(cd "$(dirname "$BRIEF")" && pwd)/$(basename "$BRIEF")")"
TMP_W="$(winpath /tmp)"
case "${BRIEF_W,,}" in
  "${TMP_W,,}"/*) mv "$BRIEF" "$RUN/brief.md" ;;
  *) cp "$BRIEF" "$RUN/brief.md" ;;
esac

LESSONS="$ROOT/$PROJECT/LESSONS.md"
EXTRA=""
[ -f "$LESSONS" ] && EXTRA=" Before starting, also read $(winpath "$LESSONS"): standing rules from earlier handoffs in this project. Follow them unless the brief says otherwise."

if [ -z "$RESUME" ]; then
  PROMPT="Your task brief is the file $RUN_W/brief.md. Read all of it before starting, then carry it out.$EXTRA Put scratch files, previews, review sheets and logs in $RUN_W (writable); write into the repository only where the brief says to. Finish with the final report the brief asks for."
  ARGS=(exec "$PROMPT" -C "$CWD_W" -s "$SANDBOX" --add-dir "$RUN_W")
  for d in ${ADD_DIRS[@]+"${ADD_DIRS[@]}"}; do ARGS+=(--add-dir "$(winpath "$d")"); done
else
  # `exec resume` takes no -s/-C/--add-dir, so pass the equivalents as config overrides.
  PROMPT="Follow-up instructions are in the file $RUN_W/brief.md. Read all of it, apply it to the work from this session, re-run the relevant verification, and finish with the same final report format as before.$EXTRA Put new previews and review sheets in $RUN_W (writable)."
  ROOTS="\"$RUN_W\""
  for d in ${ADD_DIRS[@]+"${ADD_DIRS[@]}"}; do ROOTS+=",\"$(winpath "$d")\""; done
  ARGS=(exec resume "$RESUME" "$PROMPT" -c "sandbox_mode=\"$SANDBOX\"" -c "sandbox_workspace_write.writable_roots=[$ROOTS]")
fi
ARGS+=(${MCP_APPROVE[@]+"${MCP_APPROVE[@]}"})
[ -n "$EFFORT" ] && ARGS+=(-c "model_reasoning_effort=\"$EFFORT\"")
ARGS+=(--skip-git-repo-check --json -o "$RUN_W/final.md")
for img in ${IMAGES[@]+"${IMAGES[@]}"}; do
  [ -f "$img" ] || { echo "handoff: image not found: '$img'" >&2; exit 64; }
  ARGS+=("--image=$(winpath "$img")")
done

printf 'cwd=%s\nmodel=%s\neffort=%s\nsandbox=%s\nmcp_approve=%s\nresume=%s\n' "$CWD_W" "${MODEL:-codex config}" "${EFFORT:-codex config}" "$SANDBOX" "$((${#MCP_APPROVE[@]} / 2))" "$RESUME" > "$RUN/invocation.txt"

# Snapshot the working tree so the summary can list what this run changed, however Codex wrote it.
BASE=""
if git -C "$CWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BASE="$(git -C "$CWD" stash create 2>/dev/null)"
  [ -n "$BASE" ] || BASE="$(git -C "$CWD" rev-parse --verify -q HEAD)"
  git -C "$CWD" ls-files --others --exclude-standard | sort > "$RUN/.untracked-before"
  [ -n "$BASE" ] && printf '%s
' "$BASE" > "$RUN/base.txt"
fi

START=$(date +%s)
run_with_fallback "$RUN" "${ARGS[@]}"
END=$(date +%s)
if [ "$CODE" -eq 124 ] || [ "$CODE" -eq 137 ]; then stop_run "$RUN_W" > /dev/null; fi

if [ -f "$RUN/.untracked-before" ]; then
  [ -n "$BASE" ] && git -C "$CWD" diff --stat=160 "$BASE" > "$RUN/git-changes.txt" 2>/dev/null
  git -C "$CWD" ls-files --others --exclude-standard | sort | comm -13 "$RUN/.untracked-before" - > "$RUN/git-new-files.txt"
  rm -f "$RUN/.untracked-before"
fi

node "$HERE/summarize.mjs" "$RUN" "$CODE" "$START" "$END" "$CWD_W"
STATUS=$?
# The summary already holds what the raw logs said; keep them only when a run needs diagnosing.
[ "$STATUS" -eq 0 ] && rm -f "$RUN/events.jsonl" "$RUN/stderr.log" "$RUN/invocation.txt"
printf '%s\n' "$RUN" > "$ROOT/$PROJECT/LAST_RUN"
exit $STATUS
