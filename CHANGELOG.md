# Changelog

All notable changes to this project are documented in this file. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.3.0] - 2026-08-04

### Added

- Automatic installation of a pinned official Node.js v24.19.0 LTS portable runtime on Windows, with x64/arm64 detection and embedded SHA-256 verification.
- Offline installation of locked runtime dependencies from the Release package, without npm-registry access.
- Structured Doctor diagnostics for probe phase, target, attempts, HTTP status, network category, and safe low-level cause code.
- An offline local-only Doctor mode for installation and CI verification.
- Automatic configuration and Codex-side verification of a 600-second MCP tool timeout, preventing the default 60-second host limit from cutting off normal image generation.
- A patched Hono transitive dependency override and moderate-severity production audit gate for Release builds.
- Point-in-time live acceptance evidence for a one-model catalog, including exact standard generation after earlier HTTP503s, two different multi-image count outcomes, WebP/JPEG-to-PNG fallback, repeated 4K size fallback, exact reference editing, and repeated 2K reference format fallback.
- Stable local validation errors for missing or invalid image files, with tests proving invalid reference inputs never reach the upstream service.

### Changed

- Redefined `ready=true` as local readiness to attempt one user-authorized generation, not proof of upstream generation-channel health.
- Separated model-catalog status from `generation_channel_status`; Doctor never claims a billable generation channel is available or unavailable.
- Made catalog network failures, gateway errors, and catalog-only channel messages non-blocking warnings.
- Allowed a real generation request to proceed when `/models` is unavailable or falsely reports no channel, while still blocking definite authentication failures.
- Updated the Skill and beginner documentation so users without Node.js or PowerShell 7 can install by double-clicking `install.cmd`.
- Distinguished Codex host `MCP error -32001: Request timed out` failures from MCP `upstream_timeout` and real upstream-channel evidence, with no automatic replay when billing state is uncertain.
- Made `explain_image_capability` count-aware so multi-image requests cannot borrow single-image evidence; responses now expose requested count, expected count status, and observed file count.
- Added explicit `current_catalog` versus `bundled_baseline` selection scopes so an Agent cannot present a historical fallback model as the current `auto` choice.
- Clarified that `auto` selects only from the current catalog and must adapt when the upstream changes between one and four model IDs.

### Fixed

- Normalized missing reference paths to `reference_image_not_found` and missing inspect targets to `image_not_found` instead of exposing raw filesystem `ENOENT` errors with status 0.

## [1.2.0] - 2026-08-03

### Added

- A double-click `install.cmd` entry point for first-time Windows users.
- Top-level Chinese and English capability documents included directly in GitHub Release archives.

### Changed

- Made the hardened installer compatible with both PowerShell 7 and the Windows PowerShell 5.1 runtime bundled with Windows 10 and Windows 11.
- Reworked the Chinese and English README installation sections around a beginner-first flow, while retaining command-line and checksum instructions for advanced users.
- Improved missing Node.js, npm, and Codex prerequisite messages before installation changes begin.

## [1.1.0] - 2026-08-02

### Added

- Public repository documentation in Chinese and English.
- MIT license, security policy, contribution guide, GitHub issue templates, CI, and tag-based release workflow.
- Versioned release archives and a separate SHA-256 file for each ZIP archive.
- Installer verification of the bundled npm package checksum.
- Installation ownership markers that protect unrelated directories during updates and uninstallations.

### Changed

- Reframed the repository for first-time users of Codex with text-only model APIs.
- Kept the Agent Skill concise and declared its stdio MCP dependency.
- Removed migration and cleanup behavior tied to pre-release installation names.
- Replaced a secret-like test fixture that could trigger repository scanners.

## [1.0.0] - 2026-08-02

- Initial MCP and Codex Skill release.
- Text-only MCP results with local paths and Markdown image rendering.
- Text-to-image, reference-image editing, capability evidence, output inspection, and upstream error classification.
