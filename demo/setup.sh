#!/usr/bin/env bash
# Build a throwaway world for the recorded demo, then drop into it.
#
# Sourced, not executed, so the exports survive into the shell VHS records.
#
# Everything is redirected into one temp directory. That matters more than it
# looks: `codeindex-sync install` sets the GLOBAL core.hooksPath, so a demo run
# without GIT_CONFIG_GLOBAL pinned would rewrite the git config of whoever
# recorded it. HOME alone is not enough — XDG_CONFIG_HOME may already point
# elsewhere.
set -euo pipefail

# A fixed short path, not mktemp: the recording shows these strings, and
# /var/folders/s0/jv8n2.../T/codeindex-demo.S37ryx would fill the frame.
DEMO_ROOT="${DEMO_ROOT:-/tmp/codeindex-demo}"
REPO_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# DEMO_ROOT is overridable and then fed to rm -rf, so refuse anything that is
# not a path this script would plausibly have made. Cheap insurance against a
# stray export.
if [[ "$DEMO_ROOT" != */codeindex-demo* ]]; then
  echo "refusing to rm -rf a DEMO_ROOT outside a codeindex-demo path: $DEMO_ROOT" >&2
  # `return` when sourced, `exit` when not; shellcheck reads the second as dead.
  # shellcheck disable=SC2317
  return 1 2>/dev/null || exit 1
fi
rm -rf "$DEMO_ROOT"

export HOME="$DEMO_ROOT/home"
export XDG_CONFIG_HOME="$HOME/.config"
export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
export CODEINDEX_SYNC_CONFIG="$HOME/.config/codeindex-sync/config.json"
export CODEINDEX_SYNC_STATE="$HOME/.local/state/codeindex-sync"
export CODEINDEX_SYNC_ROOT="$HOME/work"
mkdir -p "$HOME/.config/codeindex-sync" "$CODEINDEX_SYNC_STATE" "$HOME/work" "$DEMO_ROOT/bin"

# Copied in so the config shows `node /tmp/codeindex-demo/backend.mjs` rather
# than the absolute path of whoever's checkout recorded it.
cp "$REPO_SRC/demo/backend.mjs" "$DEMO_ROOT/backend.mjs"

# `codeindex-sync` on PATH, from this checkout's build.
printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$REPO_SRC/dist/cli.js" > "$DEMO_ROOT/bin/codeindex-sync"
chmod +x "$DEMO_ROOT/bin/codeindex-sync"
export PATH="$DEMO_ROOT/bin:$PATH"

git config --global user.email demo@example.com
git config --global user.name "Demo"
git config --global init.defaultBranch main

# A backend described entirely in config — no code in this project knows it.
cat > "$CODEINDEX_SYNC_CONFIG" <<JSON
{
  "root": "$HOME/work",
  "providers": [
    {
      "name": "demo-backend",
      "description": "Stub MCP index server",
      "command": "node",
      "args": ["$DEMO_ROOT/backend.mjs", "$DEMO_ROOT/index.json"],
      "tools": {
        "update": "update_index",
        "index": "rebuild_index",
        "status": "index_status",
        "list": "list_indexes"
      },
      "repoArg": "projectPath",
      "detectFiles": [".demo-backend.json"],
      "markerContent": "{\"projectId\":\"\${name}\"}\n"
    }
  ],
  "maxAttempts": 3,
  "backoffSeconds": 10,
  "logMaxBytes": 2097152
}
JSON

# A small repo to index.
mkdir -p "$HOME/work/notes/src"
cd "$HOME/work/notes"
git init -q
for f in parser search store; do
  printf 'export function %s(input) {\n  return input;\n}\n' "$f" > "src/$f.js"
done
printf '# notes\n\nA small project.\n' > README.md
git add -A && git commit -qm "initial commit"
export DEMO_REPO="$HOME/work/notes"

# Keep the prompt short so the recording is about the output, not the path.
export PS1='$ '
# Only when there is a terminal to clear; sourcing this headlessly is how the
# flow gets tested before it is recorded.
clear 2>/dev/null || true
