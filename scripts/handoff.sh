#!/usr/bin/env bash
# Stable permission-matched entrypoint; Node owns process/state handling.
set -eu
if command -v cygpath >/dev/null 2>&1; then
  export CODEX_HANDOFF_BASH="$(cygpath -m "$BASH")"
  here="$(cygpath -m "$(dirname "$0")")"
else
  here="$(dirname "$0")"
fi
exec node "$here/handoff.mjs" "$@"
