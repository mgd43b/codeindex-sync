# Releasing

## First publish (one-time)

`npm publish` needs credentials, so this step is yours:

```bash
npm login
```

Then, from a clean tree on `main`:

```bash
npm run build && npm test && npx eslint .
npm publish --access public
```

The package is configured for npm provenance, so publishing from CI attaches a
signed link back to the commit. Publishing from a laptop works too and simply
omits it.

## Homebrew

The formula installs npm's tarball, so it can only be generated *after* the
publish above:

```bash
./scripts/update-tap.sh
```

That resolves the tarball URL from the registry, hashes the actual bytes (npm
publishes sha512 integrity; Homebrew wants sha256), and writes
`Formula/codeindex-sync.rb` into the tap. Commit and push the tap, then:

```bash
brew install mgd43b/taps/codeindex-sync
```

## Subsequent releases

```bash
npm version patch      # or minor / major — commits and tags
git push --follow-tags
npm publish --access public
./scripts/update-tap.sh
```

Never hand-edit `url` or `sha256` in the formula. A hash that disagrees with
what npm serves fails at install time for every user simultaneously, and the
failure names Homebrew rather than this repo, so it is slow to diagnose.
