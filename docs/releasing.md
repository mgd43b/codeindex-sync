# Releasing

## How publishing works

Releases run from CI: publishing a **GitHub release** triggers
`.github/workflows/release.yml`, which typechecks, builds, tests, asserts the
tarball's contents, installs it into a scratch project to prove the binary
runs, and only then publishes.

There are two credential paths, and the workflow picks automatically:

| | |
|---|---|
| **Trusted publishing (OIDC)** — preferred | No secret anywhere. npm verifies the job's identity, and provenance is attached automatically. |
| **`NPM_TOKEN` secret** — fallback | Used only when the secret exists. |

**Trusted publishing cannot do the first publish.** A trusted publisher is
configured in a package's settings on npmjs.com, and those do not exist until
the package does ([npm/cli#8544](https://github.com/npm/cli/issues/8544)). So
version 0.1.0 needs one of the two options below; everything after it can be
credential-free.

### Option A — one token, then throw it away

1. Create a **granular access token** at npmjs.com, scoped to *Packages and
   scopes → Read and write*. Give it a short expiry; it is needed once.
2. Add it as the repo secret `NPM_TOKEN`
   (`gh secret set NPM_TOKEN`).
3. Cut a release — `gh release create v0.1.0 --generate-notes`. CI publishes.
4. On npmjs.com, open the package → *Settings* → *Trusted publisher*, and add
   this repository with workflow filename `release.yml` (**case-sensitive, and
   the extension must match**).
5. Delete the secret: `gh secret delete NPM_TOKEN`. Later releases use OIDC,
   and the workflow switches paths on its own.

### Option B — publish 0.1.0 by hand

```bash
npm login
npm run build && npm test && npx eslint src test
npm publish --access public
```

Then do steps 4 and 5 above. This skips creating a token at all, at the cost of
the first release not going through CI's checks.

> The workflow requires npm >= 11.5.1 for OIDC, which is why it pins Node 24 —
> Node 22 ships npm 10.9.x, which has no OIDC support. There is an explicit
> version check so that failure is legible rather than a confusing auth error.

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
gh release create "v$(node -p 'require("./package.json").version')" --generate-notes
./scripts/update-tap.sh   # once CI has published
```

The release event is what publishes; pushing a tag alone does not.

Never hand-edit `url` or `sha256` in the formula. A hash that disagrees with
what npm serves fails at install time for every user simultaneously, and the
failure names Homebrew rather than this repo, so it is slow to diagnose.
