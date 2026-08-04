# Security Policy

## Supported versions

Security fixes are provided for the latest published release.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature under the repository's **Security** tab. Do not open a public issue for a vulnerability that could expose credentials, local files, or an installation path.

If private reporting is not enabled, open a public issue containing only a request for a private contact channel. Do not include exploit details or secrets.

Never submit any of the following:

- API Keys or authorization headers.
- The contents of `state/config.json`.
- Raw upstream responses that may contain account information.
- Reference images or generated images you do not have permission to share.
- Unredacted absolute paths when they reveal a real name or organization.

Include the project version, Node.js version, Windows version, affected MCP tool, redacted error code, and minimal reproduction steps. Maintainers will acknowledge a complete private report as soon as practical and coordinate disclosure after a fix is available.

## Credential exposure

If a Key is accidentally posted, revoke or rotate it immediately. Deleting a comment or rewriting Git history is not sufficient because copies may already exist.

The installer stores the Key outside the repository and restricts the state directory ACL to the current Windows user and `SYSTEM`. The MCP never reads `OPENAI_API_KEY` and does not accept a configurable Base URL.

The Windows installer downloads its managed Node.js runtime only from the pinned official `nodejs.org` HTTPS path and verifies an embedded SHA-256 before extraction. Runtime npm dependencies are version-locked and bundled into the signed Release archive; end-user installation runs npm in offline mode and does not resolve packages from the registry.
