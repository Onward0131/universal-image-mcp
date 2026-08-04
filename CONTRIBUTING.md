# Contributing

Contributions are welcome when they preserve the project's narrow scope: one stdio MCP server and one Codex Skill for Wawapi image generation from text-only model environments.

## Development setup

Requirements:

- A supported Node.js LTS release: Node.js 22 or 24.
- npm.
- PowerShell 7 for release work on Windows. Installer changes must also parse and run under Windows PowerShell 5.1.

```powershell
npm ci
npm test
npm pack --dry-run
```

Build a local release bundle on Windows:

```powershell
npm run build:release
```

The Windows smoke test uses a local Codex configuration shim by default so GitHub-hosted runners do not need Codex installed. Before a Release, also run it locally with `-UseInstalledCodex` to verify that the current Codex binary reads back `tool_timeout_sec=600`.

Offline tests must not require an API Key or contact Wawapi. The live smoke test is optional, may incur charges, and must only be run with a Key and request authorized by its owner.

## Pull requests

- Keep the MCP response content text-only. Do not add MCP `image` content blocks or Base64 image data to tool responses.
- Do not add a web application, EXE, graphical launcher, or separate end-user CLI.
- Preserve non-idempotent billing safeguards. Ordinary HTTP502/503/524, network failures, and local timeouts must not be replayed automatically.
- Preserve the verified Codex `tool_timeout_sec=600` registration. Host timeout messages must remain distinct from MCP and upstream error envelopes.
- Add or update offline tests for behavior changes.
- Preserve the managed-runtime trust boundary: official fixed Node.js URLs, pinned hashes, no `PATH` mutation, and offline installation of bundled dependencies.
- Keep Doctor catalog warnings separate from real generation-channel evidence. A `/models` failure must not by itself block an authorized generation call.
- Update `CHANGELOG.md` for user-visible changes.
- Keep `SKILL.md` concise; put user installation and contributor material in the repository documentation.
- Never commit a real Key, copied authorization header, raw credential file, or private image.

## Capability evidence

Changes to `resources/capabilities.json` or the Skill capability reference must be based on an observed request. Record the observation time, requested model/size/format, reference-image state, HTTP outcome, and actual file metadata. Do not turn a transient 502/503/524 response into a permanent unsupported-capability claim.

Live evidence may cost money. Do not run new billable requests merely to satisfy a pull request unless the Key owner has explicitly authorized them.

## Reporting problems

Use the issue templates and redact local paths and upstream details. Report security-sensitive problems according to [SECURITY.md](SECURITY.md).
