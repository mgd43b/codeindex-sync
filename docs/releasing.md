# Releasing

## How publishing works

Versions are cut by [release-please](https://github.com/googleapis/release-please).
It watches conventional commits landing on `main` and keeps a **release PR**
open with the version bump and the CHANGELOG entry it would produce. Merging
that PR is the release: release-please tags it, creates the GitHub release, and
hands off to `.github/workflows/release.yml`, which typechecks, builds, tests,
asserts the tarball's contents, installs it into a scratch project to prove the
binary runs, and only then publishes.

Nothing is released as a side effect of merging ordinary work — the release PR
is a separate, reviewable merge, and the version and changelog are visible in it
before anything is published.

Commit subjects therefore matter: `feat:` bumps the minor, `fix:` the patch, and
anything else (`chore:`, `docs:`, `build:`, `ci:`, `test:`, `refactor:`) lands
without proposing a release. While the version is below 1.0.0 a breaking change
bumps the minor rather than the major.

> **Why release-please calls the publish workflow directly.** A release created
> with the default `GITHUB_TOKEN` does not start other workflows, so
> `release.yml`'s `release: published` trigger never fires for one. The
> alternative is a long-lived personal access token whose only job is to bridge
> that gap; calling the workflow is the same result without the credential. A
> release you cut by hand still triggers `release.yml` the ordinary way.

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
3. Merge the release-please PR (or, if you would rather not wait for one,
   `gh release create v0.1.0 --generate-notes`). CI publishes either way.
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
publishes sha512 integrity; Homebrew wants sha256), renders the formula from
`packaging/homebrew/codeindex-sync.rb`, commits and pushes it to the tap, then
installs it to prove it builds. Re-running once the formula already matches is a
no-op, so it is safe after any release.

`--dry-run` shows the diff and changes nothing; `--skip-test` pushes without the
install check; a version argument publishes something other than `latest`.

**`brew` does not read your working clone of the tap.** It reads its own, under
`$(brew --prefix)/Library/Taps/…`, which contains only what has been pushed and
fetched — so a formula written locally and left uncommitted is both correct and
invisible, and `brew install` answers "No available formula" without mentioning
the tap or the missing push. The script fast-forwards brew's clone after
pushing, which is what keeps those two in agreement.

One trap it checks for rather than letting Homebrew report obliquely: anything
already occupying `$(brew --prefix)/bin/codeindex-sync` — a global npm install
or `npm link`, say — makes brew refuse to link, and the error talks about
symlinks rather than about what put one there. Remove it first
(`npm rm -g codeindex-sync`).

## Subsequent releases

Merge the open **release-please** PR. That is the whole procedure: it bumps
`package.json`, updates `CHANGELOG.md`, tags, creates the GitHub release, and
publishes. Afterwards:

```bash
./scripts/update-tap.sh   # once CI has published
```

Do not hand-bump the version or run `npm version` — release-please owns the
version, and a manual bump only makes its next PR disagree with the tree.

To force a specific version (a release-please PR proposing something you do not
want, say), put a footer on any commit before merging the release PR:

```
Release-As: 0.4.0
```

### Validating without releasing

```bash
gh workflow run release.yml
```

That runs every check the real publish runs — build, tests, tarball contents,
packed-binary smoke test — and stops before publishing. Pass `-f publish=true`
only if you intend it to actually publish.

### What release-please believes the current version is

`.release-please-manifest.json`, seeded to `0.0.0`. That alone is *not* what
makes the first release `0.1.0` — with no release to find, release-please falls
back to its own initial version, which defaults to `1.0.0`. `initial-version`
in `release-please-config.json` pins it to `0.1.0`, matching `package.json`.

After the first release, release-please maintains the manifest and it should not
be edited by hand.

`include-component-in-tag` is false so tags are `v0.1.0` rather than
`codeindex-sync-v0.1.0` — the component prefix is for monorepos releasing
several packages from one repo.

Never hand-edit `url` or `sha256` in the formula. A hash that disagrees with
what npm serves fails at install time for every user simultaneously, and the
failure names Homebrew rather than this repo, so it is slow to diagnose.
