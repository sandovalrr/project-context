# Releasing

Releases use semantic-release for version selection and changelog generation,
but separate artifact preparation from publication. A maintainer explicitly
starts preparation; a human explicitly publishes the GitHub draft; automation
then publishes the exact draft tarball to npm and the official MCP Registry.

## One-time repository setup

1. Create a protected GitHub environment named `release` with required
   reviewer approval.
2. Register a private release GitHub App with webhooks disabled and repository
   `Contents: read and write` as its only mutable permission. Install it only on
   this repository.
3. Store the App client ID as the `RELEASE_APP_CLIENT_ID` environment variable
   and its private key as the `RELEASE_APP_PRIVATE_KEY` environment secret.
4. Protect `main`, require the CI checks, prevent release-tag creation,
   deletion, or rewrites, and grant ruleset bypass only to the release App.
5. Enable private vulnerability reporting and Dependabot alerts.
6. Keep the built-in Actions token read-only. The prepare workflow creates a
   short-lived, repository-scoped App token with `contents: write`; the publish
   workflow receives `contents: read` and `id-token: write`.
7. Require CODEOWNERS review for workflows, release scripts, schemas, lockfiles,
   and package/registry metadata.

No long-lived npm or MCP Registry publishing token belongs in GitHub secrets.
The release App token is generated on demand and revoked when the preparation
job finishes.

## Bootstrap npm ownership

npm trusted publishing can be configured only after the package exists. The
maintainer performs one bootstrap publication from a clean `main` checkout:

```sh
bun ci
bun run check
bun audit --audit-level=high
bun run test:packed
npm publish --access public --tag bootstrap
git tag v0.0.0
git push origin v0.0.0
```

This publishes package version `0.0.0` under the non-default `bootstrap` tag.
Do not create a GitHub release for it and do not publish it to the MCP Registry.
Use npm's interactive authentication and current account protections for this
one operation.

Then configure npm **Trusted Publisher** for:

```text
GitHub owner: sandovalrr
Repository: project-context
Workflow filename: publish-release.yml
Environment: release
Allowed operation: npm publish
```

Restrict or revoke traditional automation tokens after trusted publishing is
active.

## Version policy

Conventional Commit subjects determine the release:

- `fix:` produces a patch.
- `feat:` produces a minor.
- `feat!:` or `BREAKING CHANGE:` produces a major after 1.0.
- Before 1.0, a breaking change produces a minor unless the workflow's
  `release_1_0` input is explicitly enabled.

`CHANGELOG.md`, `package.json`, `bun.lock`, and `server.json` are synchronized in
one release commit. Release tags are `v<version>` and are immutable.

## Prepare a draft

1. Confirm `main` is green and every intended commit follows Conventional
   Commits.
2. Run **Actions → Prepare Release → Run workflow**.
3. Leave `release_1_0` false unless this is the deliberately reviewed first
   stable release.
4. Approve the protected `release` environment.

The workflow rechecks package age, types, lint, tests, and dependency audit.
semantic-release calculates the version and changelog. The preparation plugin:

- synchronizes all version fields;
- updates the Bun lockfile;
- builds both Node executables;
- creates one npm tarball;
- creates and validates a reproducible CycloneDX JSON application SBOM;
- writes SHA-256 checksums for the tarball and SBOM;
- installs and exercises the exact tarball through MCP;
- creates a GitHub-verified bot release commit through the Git database API.

semantic-release tags that verified commit and opens a **draft** GitHub release
with the exact artifacts. It does not publish npm or registry metadata.

## Review and publish

Before publishing the draft:

1. Review the generated changelog and semantic version.
2. Confirm the tag targets the release commit and GitHub shows it as verified.
3. Download the tarball, SBOM, and checksum manifest; verify the checksums.
4. Inspect `npm pack` contents and confirm no configuration, secrets, build
   cache, source maps beyond the declared bundle maps, or unexpected files.
5. Confirm `package.json` `mcpName` equals `server.json` `name` and versions
   match.

Publishing the GitHub draft triggers `publish-release.yml`. The workflow:

1. checks out the immutable tag;
2. downloads the draft-built assets;
3. verifies tag, versions, exact asset set, checksums, SBOM type, and packaged
   MCP behavior;
4. publishes that tarball to npm with trusted-publisher OIDC provenance;
5. waits until npm exposes the exact version;
6. downloads MCP Registry publisher `v1.7.9`, verifies its pinned SHA-256, and
   authenticates with GitHub OIDC;
7. publishes `server.json` and verifies the exact registry version.

## Failure recovery

Releases and npm versions are immutable. Never move a tag, replace an attached
asset, or overwrite a published version.

- Preparation failure: fix `main` and run Prepare Release again. Delete only an
  unpublished draft/tag if the failed run created them and no consumer could
  have used them.
- npm failure: leave the GitHub release published, correct trusted-publisher or
  environment configuration, and rerun the failed publish workflow. The exact
  tarball is reused.
- MCP Registry failure after npm success: use **Re-run failed jobs**. Registry
  publication is a separate job that downloads and revalidates the original
  assets, confirms npm, and retries only registry login/publish/verify; it does
  not attempt a duplicate npm publication.
- Defective public release: deprecate the npm version when appropriate and
  publish a new fix-forward version. Do not edit history.
- Compromised release: follow private security reporting, revoke affected
  credentials/trust relationships, preserve evidence, deprecate the package,
  and publish a new version only after the release chain is trustworthy.

## Local dry run

With a clean branch and no intent to publish:

```sh
bun ci
bun run check
bun run test:packed
bun run release:dry-run
```

semantic-release dry-run may still query GitHub. Never place an npm token in a
local environment for this project.
