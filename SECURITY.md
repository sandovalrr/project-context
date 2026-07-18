# Security policy

## Supported versions

Security fixes are provided only for the latest published release. Older
versions, prereleases, unpublished commits, and forks are unsupported. Before
reporting a problem, reproduce it against the latest release when doing so is
safe and does not risk exposing a credential or performing an unwanted write.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, exposed credential,
or bypass of an identity, routing, preview, permission, origin, or redaction
boundary.

Use **Report a vulnerability** from the repository's **Security** tab. Include
the affected version, operating system, MCP client, reproduction steps, impact,
and suggested mitigation. Use temporary test accounts and fully redact tokens,
project mappings, issue content, local paths, and organization identifiers.

If private vulnerability reporting is unavailable, contact the maintainer
privately through the GitHub profile before disclosure. Allow time to confirm
the report, prepare a fix, and coordinate publication. Releases are immutable;
a correction is published as a new version and the affected version may be
deprecated.

## Security expectations

The server is designed for one trusted local OS account. It does not protect
against an attacker who already controls that account, its MCP client, its
process environment, or its credential stores. Review the detailed trust
boundaries and residual risks in [`docs/threat-model.md`](docs/threat-model.md).
