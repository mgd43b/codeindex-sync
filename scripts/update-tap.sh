#!/usr/bin/env bash
# Publish the live Homebrew formula for the current npm release.
#
# The formula installs npm's tarball, so this can only run AFTER `npm publish`.
# Both the URL and the hash come from the registry rather than being typed: a
# formula whose sha256 does not match what npm serves fails at install time for
# every user at once, and the failure names Homebrew rather than this repo, so
# it is slow to diagnose.
#
# ## Two clones, and why this one
#
# `brew` does not read your working copy of the tap. It reads its OWN clone
# under `$(brew --prefix)/Library/Taps/<owner>/homebrew-<tap>`, which only ever
# contains what has been pushed and fetched. Writing a formula into a working
# clone and stopping there produces a file that exists, is correct, and is
# invisible to `brew install` — which reports "No available formula", naming
# neither the tap nor the missing push.
#
# So this writes to the working clone (where your history belongs), pushes, and
# then fast-forwards brew's clone so the two agree before it tries to install.
# It deliberately does not commit inside brew's directory: that is Homebrew's to
# manage, and local commits there collide with `brew update`.
set -euo pipefail

PKG="codeindex-sync"
TAP_OWNER="mgd43b"
TAP_NAME="taps"
TAP="${TAP_DIR:-$HOME/workspace/homebrew-$TAP_NAME}"
TEMPLATE="$(cd "$(dirname "$0")/.." && pwd)/packaging/homebrew/$PKG.rb"
FORMULA_REL="Formula/$PKG.rb"

VERSION="latest"
DRY_RUN=false
SKIP_TEST=false

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[0;34m' G=$'\033[0;32m' Y=$'\033[1;33m' R=$'\033[0;31m' N=$'\033[0m'
else
  B='' G='' Y='' R='' N=''
fi
info() { printf '%s\n' "${B}·${N} $*"; }
ok()   { printf '%s\n' "${G}✔${N} $*"; }
warn() { printf '%s\n' "${Y}▲${N} $*" >&2; }
die()  { printf '%s\n' "${R}✘${N} $*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $0 [version] [options]

Render the Homebrew formula from the published npm package, push it to the tap,
and verify it installs.

Arguments:
  version        npm version to publish (default: latest)

Options:
  --dry-run      Show the formula diff and stop, changing nothing
  --skip-test    Push without running 'brew install' afterwards
  -h, --help     This message

Environment:
  TAP_DIR        Working clone of the tap (default: \$HOME/workspace/homebrew-$TAP_NAME)
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --skip-test) SKIP_TEST=true ;;
    -h|--help) usage ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) VERSION="$1" ;;
  esac
  shift
done

sha256_of() {
  # Linux ships sha256sum, macOS ships shasum. Neither is guaranteed.
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else die "no shasum or sha256sum on PATH"
  fi
}

# ── resolve the release from the registry ─────────────────────────────────────
[ -f "$TEMPLATE" ] || die "formula template missing: $TEMPLATE"

info "Resolving $PKG@$VERSION from the npm registry"
# No -S here: a missing version is an ordinary outcome and curl's own 404 line
# only clutters the message below. The tarball fetch keeps it, where a network
# failure is worth seeing in full.
meta=$(curl -fsL "https://registry.npmjs.org/$PKG/$VERSION") ||
  die "no such published version: $PKG@$VERSION (publish it first)"
url=$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dist"]["tarball"])')
resolved=$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')

tmp=$(mktemp); backup=""
trap 'rm -f "$tmp" ${backup:+"$backup"}' EXIT
curl -fsSL "$url" -o "$tmp" || die "could not download $url"
# npm publishes a sha512 integrity string, but Homebrew wants sha256 of the
# actual bytes — so hash the tarball rather than trusting the metadata.
sha=$(sha256_of "$tmp")
ok "$PKG $resolved"
info "  $url"
info "  sha256 $sha"

# ── update the working clone ──────────────────────────────────────────────────
[ -d "$TAP/.git" ] || die "tap working clone not found at $TAP (set TAP_DIR)"

# Not fatal: an untracked formula is simply the first publish, and the file is
# generated, so local edits to it are a mistake rather than work to protect.
# Worth saying out loud before they are overwritten, though.
if ! git -C "$TAP" diff --quiet -- "$FORMULA_REL" 2>/dev/null; then
  warn "$FORMULA_REL has local edits; they will be replaced (it is generated)"
fi

branch=$(git -C "$TAP" symbolic-ref --quiet --short HEAD) || die "$TAP is not on a branch"
info "Syncing $TAP ($branch)"
git -C "$TAP" pull --ff-only --quiet origin "$branch" ||
  die "could not fast-forward $TAP; reconcile it by hand"

mkdir -p "$TAP/$(dirname "$FORMULA_REL")"
# Kept so --dry-run can put back exactly what was there, including a formula
# that was never committed. Restoring with `git checkout` cannot do that.
if [ -f "$TAP/$FORMULA_REL" ]; then
  backup=$(mktemp)
  cp "$TAP/$FORMULA_REL" "$backup"
fi
sed -e "s|NPM_TARBALL_URL|$url|" -e "s|NPM_TARBALL_SHA256|$sha|" \
  "$TEMPLATE" > "$TAP/$FORMULA_REL"

# Rendering from a template means url and sha256 are replaced together, every
# time. Editing an existing formula in place cannot promise that: a pattern that
# stops matching updates the hash and leaves the URL, silently.
if grep -q 'NPM_TARBALL_' "$TAP/$FORMULA_REL"; then
  die "template placeholders survived substitution — check $TEMPLATE"
fi

if git -C "$TAP" diff --quiet -- "$FORMULA_REL" &&
   [ -z "$(git -C "$TAP" status --porcelain -- "$FORMULA_REL")" ]; then
  ok "formula already matches $resolved; nothing to publish"
  exit 0
fi

info "Formula changes:"
git -C "$TAP" --no-pager diff -- "$FORMULA_REL" || true
git -C "$TAP" --no-pager status --short -- "$FORMULA_REL"

if [ "$DRY_RUN" = true ]; then
  if [ -n "$backup" ]; then cp "$backup" "$TAP/$FORMULA_REL"; else rm -f "$TAP/$FORMULA_REL"; fi
  warn "dry run: nothing committed, working clone restored"
  exit 0
fi

# ── publish ───────────────────────────────────────────────────────────────────
git -C "$TAP" add "$FORMULA_REL"
git -C "$TAP" commit --quiet -m "$PKG $resolved"
git -C "$TAP" push --quiet origin "$branch"
ok "pushed $PKG $resolved to $TAP_OWNER/homebrew-$TAP_NAME"

# ── let brew's own clone catch up ─────────────────────────────────────────────
if ! command -v brew >/dev/null 2>&1; then
  warn "brew not on PATH; skipping install check"
  exit 0
fi

brew_tap="$(brew --repository)/Library/Taps/$TAP_OWNER/homebrew-$TAP_NAME"
if [ -d "$brew_tap/.git" ]; then
  # Targeted, because `brew update` also refreshes homebrew-core — tens of
  # megabytes to learn about one formula we just pushed ourselves.
  git -C "$brew_tap" fetch --quiet origin
  git -C "$brew_tap" merge --ff-only --quiet FETCH_HEAD ||
    warn "could not fast-forward brew's tap clone; run: brew update"
  ok "brew's tap clone is up to date"
else
  warn "tap not tapped locally; run: brew tap $TAP_OWNER/$TAP_NAME"
  exit 0
fi

[ "$SKIP_TEST" = false ] || { warn "skipping install check (--skip-test)"; exit 0; }

# The trap that is easy to hit and hard to read: anything already occupying the
# binary's path — an `npm link`, a hand-made symlink — makes brew refuse to
# link, and the error talks about symlinks rather than about what put it there.
bin_path="$(brew --prefix)/bin/$PKG"
if [ -e "$bin_path" ] && ! brew list --formula "$PKG" >/dev/null 2>&1; then
  target=$(readlink "$bin_path" 2>/dev/null || echo "a regular file")
  warn "$bin_path already exists and Homebrew does not own it"
  warn "  it points at: $target"
  die  "remove it first (for a global npm install: npm rm -g $PKG)"
fi

info "Installing to verify the formula builds"
if brew list --formula "$PKG" >/dev/null 2>&1; then
  brew reinstall --build-from-source "$TAP_OWNER/$TAP_NAME/$PKG"
else
  brew install --build-from-source "$TAP_OWNER/$TAP_NAME/$PKG"
fi

got=$("$bin_path" --version)
[ "$got" = "$resolved" ] || die "installed $got but published $resolved"
ok "installed $PKG $got from the tap"
