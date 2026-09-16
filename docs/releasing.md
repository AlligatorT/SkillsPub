# Releasing SkillsPub

This checklist is for the human release gate. Running repository verification does not publish a package, create a release, or change repository visibility.

## Prerequisites

### npm

- Maintainer access to the `skillspub` package name.
- An npm account with two-factor authentication configured for publishing.
- A current npm login: `npm whoami` must return the intended maintainer.
- Node.js 22.20 or newer and npm 10 or newer.

The first publish is an interactive maintainer 2FA cutover. Configure trusted publishing and provenance only after that flow is proven; do not weaken 2FA to automate v0.1.0.

### GitHub

- Admin permission for `AlligatorT/SkillsPub`, including repository visibility changes.
- Permission to push the `v0.1.0` tag and create a GitHub Release.
- Required CI checks passing for the exact release commit.
- A reviewed backup or local clone of the private repository before changing visibility.

### Homebrew

- Admin permission for `AlligatorT/homebrew-tap`.
- Homebrew installed locally for Formula audit and install tests.
- The npm tarball URL and SHA-256 from the published immutable v0.1.0 artifact.

The first Formula is manual and happens only after npm and the matching GitHub release succeed.

## Reproducible preflight

From a clean checkout of the release commit:

```sh
npm ci
npm run typecheck
node --test test/shared.test.ts test/harnesses.test.ts test/cli.test.ts test/tui.test.ts
npm test
npm run build
npm run audit:release
npm run check:package
npm pack --ignore-scripts
npm run check:package -- ./skillspub-0.1.0.tgz
npm pack --dry-run --ignore-scripts
```

Record the commit SHA, each command and bounded result, tarball filename/SHA-256, and `npm pack --dry-run` file list on the release-candidate ticket before opening the release PR; copy that evidence into the release notes at publication. Confirm the tarball contains only `dist/**`, `README.md`, `LICENSE`, and `package.json`. Keep real-machine acceptance output outside the package.

## Recoverable cutover

1. Freeze release changes and verify the recorded commit is the checked-out `HEAD`.
2. Complete the reproducible preflight above. Stop on any mismatch; fix forward on a new commit and restart.
3. Review the tracked-file secret, privacy, and license audit output. Review the tarball file list separately so unrelated untracked files cannot enter the package.
4. Change `AlligatorT/SkillsPub` to public. Immediately verify anonymous read access and the README/license rendering. If repository exposure is wrong, restore private visibility before publishing npm and investigate.
5. Publish the exact verified tarball with maintainer 2FA: `npm publish ./skillspub-0.1.0.tgz --access public`.
6. Verify from a clean temporary directory with `npm view skillspub@0.1.0` and `npx skillspub@0.1.0 targets --json`. npm versions are immutable; if verification fails, deprecate the broken version with a clear message, fix forward with a new patch version, and do not reuse `0.1.0`.
7. Tag the recorded commit as `v0.1.0`, push the tag, and create a GitHub Release that includes the recorded tarball SHA-256. If this step fails, leave npm intact, repair GitHub permissions or metadata, and create the tag/release from the same recorded commit.
8. Create the Homebrew Formula from the published npm artifact and recorded SHA-256, then run `brew audit --strict` and a clean `brew install` smoke test. If it fails, fix the tap Formula without changing the npm artifact.
9. Confirm npm, GitHub, and Homebrew all resolve to v0.1.0 from the recorded commit, then unfreeze development.

Never delete or overwrite a published npm version as a rollback strategy. Deprecate and fix forward. Repository visibility can be restored before npm publication, while GitHub release metadata and the Homebrew Formula remain independently repairable afterward.
