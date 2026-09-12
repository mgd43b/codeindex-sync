# Changelog

## [0.4.0](https://github.com/mgd43b/codeindex-sync/compare/v0.3.2...v0.4.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* Node 20 is no longer supported; the minimum is Node 22.12.

### Features

* require Node 22.12, and take vitest 5 ([#37](https://github.com/mgd43b/codeindex-sync/issues/37)) ([b06a9b8](https://github.com/mgd43b/codeindex-sync/commit/b06a9b89ea836f319cb4ddc235193881b72cc24c))

## [0.3.2](https://github.com/mgd43b/codeindex-sync/compare/v0.3.1...v0.3.2) (2026-09-12)


### Bug Fixes

* **sync:** report an unchanged repository as unchanged, not failed ([#35](https://github.com/mgd43b/codeindex-sync/issues/35)) ([970c797](https://github.com/mgd43b/codeindex-sync/commit/970c7976a29c8c749f157f65a1a291c3dac275a7))

## [0.3.1](https://github.com/mgd43b/codeindex-sync/compare/v0.3.0...v0.3.1) (2026-09-11)


### Bug Fixes

* **sync:** report an unchanged repository as unchanged, not failed ([#33](https://github.com/mgd43b/codeindex-sync/issues/33)) ([a95962b](https://github.com/mgd43b/codeindex-sync/commit/a95962b7489124e59003ed1079a5655a5c521e3e))

## [0.3.0](https://github.com/mgd43b/codeindex-sync/compare/v0.2.0...v0.3.0) (2026-09-10)


### Features

* never index a worktree, and make the excluded paths config ([#31](https://github.com/mgd43b/codeindex-sync/issues/31)) ([6a78dcd](https://github.com/mgd43b/codeindex-sync/commit/6a78dcd0f6ccdaa553c83dbee028e54d4fda6149))

## [0.2.0](https://github.com/mgd43b/codeindex-sync/compare/v0.1.2...v0.2.0) (2026-09-09)


### Features

* add a verify command that checks an index against itself ([#26](https://github.com/mgd43b/codeindex-sync/issues/26)) ([6e7f036](https://github.com/mgd43b/codeindex-sync/commit/6e7f0364d7dde8c0ba51f41cbee682468a1ca5a5))


### Bug Fixes

* **verify:** serialise --repair behind the worker lock ([#28](https://github.com/mgd43b/codeindex-sync/issues/28)) ([34bcd85](https://github.com/mgd43b/codeindex-sync/commit/34bcd857c7c0bd288e35d7d709f8ff9cec7c54b5))

## [0.1.2](https://github.com/mgd43b/codeindex-sync/compare/v0.1.1...v0.1.2) (2026-09-09)


### Bug Fixes

* read the version from package.json instead of a hardcoded literal ([#24](https://github.com/mgd43b/codeindex-sync/issues/24)) ([3484ea4](https://github.com/mgd43b/codeindex-sync/commit/3484ea405775d3ca5da87c9f9753705965b10fcc))

## [0.1.1](https://github.com/mgd43b/codeindex-sync/compare/v0.1.0...v0.1.1) (2026-09-09)


### Bug Fixes

* **provider:** disable backend startup auto-indexing in spawned sessions ([#22](https://github.com/mgd43b/codeindex-sync/issues/22)) ([1e6dd2f](https://github.com/mgd43b/codeindex-sync/commit/1e6dd2fab01c41f550b8b55d68256c87fd5ffbce))

## 0.1.0 (2026-09-04)


### Features

* add claim/unclaim, and group the command list by task (re-targeted at main) ([#16](https://github.com/mgd43b/codeindex-sync/issues/16)) ([9ff7d67](https://github.com/mgd43b/codeindex-sync/commit/9ff7d67adb39cb35eb3adf0420dc1533b2f7a7de))
* cleanup, gone-branch worktree pruning, log -f, list --all/--json/--stale ([8e18597](https://github.com/mgd43b/codeindex-sync/commit/8e185975afe81675e62e682c2b64dd4730cbd986))
* cover repos that set their own core.hooksPath; fix silent hook drops ([5b26164](https://github.com/mgd43b/codeindex-sync/commit/5b26164577532eef06c00435e9f4f78de2ba71bf))
* hooks kick a detached drain, so commits index immediately ([61e2725](https://github.com/mgd43b/codeindex-sync/commit/61e2725e2481bd35153432fcf62f18a507c04447))
* list --all reports status, age, file counts and collection ([015d766](https://github.com/mgd43b/codeindex-sync/commit/015d7668b07008a6ab702bd32acc122eb7a9a093))
* schedule the drain, shell completion; fix unreachable code after ui.fail ([c41051e](https://github.com/mgd43b/codeindex-sync/commit/c41051edc3ceb81d91b3ae83b67b6e0e9715d75b))


### Bug Fixes

* bold the list header so it is not styled identically to the data ([7a502b4](https://github.com/mgd43b/codeindex-sync/commit/7a502b402817dcc8bb223e4139552d0e0913f211))
* confirm a removal against the backend instead of trusting the reply ([#12](https://github.com/mgd43b/codeindex-sync/issues/12)) ([07422f5](https://github.com/mgd43b/codeindex-sync/commit/07422f505e515fd2784b4c624652fc3fe897d205))
* give scheduled jobs a PATH that can find node and npx ([8507153](https://github.com/mgd43b/codeindex-sync/commit/85071530316f09a58ede41593c21170aebd89360))
* install a dispatcher for every hook type, not just the indexing ones ([69a638d](https://github.com/mgd43b/codeindex-sync/commit/69a638d9aa56698e959a7f3f393e86bc13bd0a12))
* lint errors in the completion generator ([462f82b](https://github.com/mgd43b/codeindex-sync/commit/462f82bccac242835c192108595ebd29771834a2))
* never take git's optional index lock ([04e6aec](https://github.com/mgd43b/codeindex-sync/commit/04e6aec421619ddce36b75393f28b510e49273a9))
* replace hook entries instead of writing through symlinks ([0a57dd4](https://github.com/mgd43b/codeindex-sync/commit/0a57dd452df63266d552857531fea4a23f84f149))
* wait for an async index tool instead of reporting "started" as done ([#11](https://github.com/mgd43b/codeindex-sync/issues/11)) ([65c4c89](https://github.com/mgd43b/codeindex-sync/commit/65c4c891d871552025004497614ee9ecd962a480))
