# Changelog

## [2.0.0] - 2026-09-09

### Breaking changes

- Rename the project, package, executable, and installation directory to `universal-image-mcp`; MCP and Skill use `universal-image`.
- Remove the fixed third-party Base URL, provider-specific environment aliases, default model, historical model preferences, and bundled capability snapshot.
- Require an explicit connection. Use `IMAGE_MCP_CONFIG`, `IMAGE_MCP_HOME`, and `IMAGE_API_*` settings.
- All billable submissions execute once. The old provider-specific automatic retry and asynchronous probing paths are removed.

### Added

- OpenAI Images-compatible, Gemini generateContent, and chat image adapters for generation and single-reference editing.
- Provider presets, configurable authentication, request headers, endpoints, query parameters, extra JSON, omitted fields, output directory, and timeout.
- Complete configuration import and preservation during upgrades; isolated MCP config paths and name-only environment forwarding.
- Offline protocol, HTTP-to-disk, concurrency, and real stdio tests; authorized generation and editing acceptance tests against a configured third-party service.

### Fixed

- Configuration failures return structured MCP errors without terminating the server.
- Redirects cannot forward API credentials, response sizes are bounded, and sensitive values are redacted from results.
- Reference files are checked before loading; concurrent output names cannot overwrite existing files.
- Updated locked production dependencies and audit gate.

Previous versions remain available in repository tags and releases. Their installation names and implicit connection behavior are not retained in v2.0.0.
