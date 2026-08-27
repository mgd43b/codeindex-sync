#!/usr/bin/env bash
# Generate the live Homebrew formula from the published npm package.
#
# The formula installs npm's tarball, so this can only run AFTER `npm publish`.
# Both the URL and the hash come from the registry rather than being typed:
# a formula whose sha256 does not match what npm serves fails at install time
# for every user at once.
set -euo pipefail

PKG="codeindex-sync"
TAP="${TAP_DIR:-$HOME/workspace/homebrew-taps}"
TEMPLATE="$(dirname "$0")/../packaging/homebrew/$PKG.rb"
VERSION="${1:-latest}"

meta=$(curl -fsSL "https://registry.npmjs.org/$PKG/$VERSION")
url=$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dist"]["tarball"])')
version=$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')

# npm publishes a sha512 integrity string, but Homebrew wants sha256 of the
# actual bytes — so hash the tarball rather than trusting the metadata.
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp"
sha=$(shasum -a 256 "$tmp" | awk '{print $1}')

out="$TAP/Formula/$PKG.rb"
mkdir -p "$(dirname "$out")"
sed -e "s|NPM_TARBALL_URL|$url|" -e "s|NPM_TARBALL_SHA256|$sha|" "$TEMPLATE" > "$out"

echo "wrote $out"
echo "  version $version"
echo "  sha256  $sha"
echo
echo "next: commit and push the tap, then verify with"
echo "  brew install --build-from-source $out"
