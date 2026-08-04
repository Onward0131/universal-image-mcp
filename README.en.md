# Wawapi Image MCP

English | [简体中文](README.md)

Wawapi Image MCP lets Codex generate, edit, save, and display images while the active model API remains text-only. A local stdio MCP server handles image bytes; Codex receives structured text, local paths, and Markdown instead of MCP `image` content blocks.

> This is an independent community integration. It is not an official Wawapi, OpenAI, or Codex project. Users must obtain an authorized Wawapi API Key and follow the provider's terms, content policies, and billing rules.

## Three-step Windows install

### Before you start

- Windows 10 or Windows 11.
- A working Codex installation with the `codex` command available in a terminal.
- A Wawapi API Key with image-service access.
- Network access to the official Node.js site and Wawapi.

No preinstalled Node.js, npm, PowerShell 7, or administrator access is required. `install.cmd` prefers `pwsh` when available and otherwise uses the Windows PowerShell 5.1 runtime included with Windows. The installer places a pinned official portable Node.js runtime inside the project installation and does not modify the system `PATH`.

### Install

1. Download `Wawapi-Image-MCP-v<version>.zip` from [GitHub Releases](../../releases/latest).
2. Extract the ZIP. Do not run files from inside the archive preview window.
3. In the extracted folder, double-click `install.cmd` and enter the API Key when prompted. On first install it downloads and verifies the managed Node.js runtime; keep the window and network connection open until completion.
4. Fully quit and reopen Codex, then create a new task.

The installer does not display or log the complete Key. If Windows blocks the script, first verify that the ZIP came from this project's Release and compare its SHA-256. Do not run a copy from an untrusted source.

### First generation

Enter this in a new Codex task:

```text
Use $wawapi-image to generate a 1024x1024 PNG of a red paper crane on a white studio background, centered, with a soft shadow and no text. Display the result in this conversation.
```

Codex should check the MCP, generate and save the file, and display it in the conversation. The Skill checks capability evidence before 2K, 4K, unusual-aspect-ratio, non-PNG, multi-image, or reference-image work.

### Common installation problems

| Message | What to do |
|---|---|
| The Node.js runtime download failed | Confirm access to `nodejs.org` and check proxy, firewall, or enterprise network policy, then double-click `install.cmd` again |
| The Node.js SHA-256 check failed | Do not bypass verification; rerun the installer and redownload this project's GitHub Release if it persists |
| The Windows architecture is unsupported | Automatic installation currently supports x64 and arm64 Windows |
| The Codex command was not found | Install or update Codex and confirm that `codex --version` works in a terminal |
| The Key is invalid | Ask the Key provider to confirm authentication and image-service access, then rerun the installer |
| The model catalog was not verified | This is non-blocking and does not prove a generation-channel outage; the Skill proceeds with one real request when the user asked for an image |
| A real generation reports no upstream channel | Wait for recovery or contact the Key provider; do not change prompt, size, or model to bypass it |
| Installation completed but Codex has no image tools | Fully quit Codex, reopen it, and create a new task |
| Generation ends near 60 seconds with `MCP error -32001: Request timed out` | This is a Codex host timeout, not a Doctor or upstream-channel conclusion. Rerun the latest `install.cmd`, confirm the summary reports a verified 600-second MCP tool timeout, fully restart Codex, and do not automatically replay the previous request |

## What is included

The repository exposes exactly two user-facing capabilities:

- `wawapi-image` MCP: calls the Wawapi image API, validates and saves files, and returns text-only tool results.
- `$wawapi-image` Codex Skill: tells Codex how to check readiness, select tools, control billable calls, explain degraded output, and render local files.

`install.cmd` is only a Windows installation entry point. The project has no web app, desktop app, EXE, graphical interface, or separate image CLI.

## When to use it

This project is designed for environments where:

- Codex uses a text-only model API, while the Codex host can still call local MCP tools.
- The model cannot consume image tool results but can consume text and local file paths.
- Users want text-to-image generation or reference-image transformation through natural language.

It is not a fit when:

- The Agent or host cannot call MCP tools at all.
- The text model must visually judge the generated image. The MCP can validate a file but cannot give a text-only model visual perception.
- A configurable OpenAI-compatible endpoint is required. The endpoint is deliberately fixed to `https://wawapii.com/v1` so configuration cannot redirect the Key.
- A one-command non-Windows installer is required. The runtime is platform-neutral Node.js, but the hardened installer currently supports Windows 10 and Windows 11 only.

## How it works

```text
User requests an image
  -> Codex loads $wawapi-image
  -> Codex calls the local stdio MCP server
  -> MCP calls the Wawapi image endpoint
  -> MCP validates and saves the real image file
  -> MCP returns text JSON, an absolute path, and Markdown
  -> Codex renders the local file in the conversation
```

Successful and failed MCP responses contain only `text` content blocks. Image Base64 never enters the conversation context.

## What the installer does

The installer verifies the bundled npm package, downloads the pinned official Node.js v24.19.0 LTS portable ZIP and checks its embedded SHA-256, reads the Key through masked input, protects configuration with Windows ACLs, installs the Skill, registers the MCP server, sets and verifies the Codex MCP tool timeout at 600 seconds, and runs a read-only Doctor through a real stdio session. Runtime dependencies are bundled in the Release package, so installation does not resolve or download packages from the npm registry. Codex defaults MCP tool calls to 60 seconds, while real image generation can take longer, so this registration setting is required.

The official Codex [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) defines `mcp_servers.<id>.tool_timeout_sec` as the override for the default 60-second tool timeout. This installer changes only the `wawapi-image` server section.

The default location is `D:\CodexTools\wawapi-image-mcp`; without a `D:` drive it uses `%LOCALAPPDATA%\CodexTools\wawapi-image-mcp`. Managed Node.js lives under its `runtime` directory, and the MCP launcher always invokes that exact executable. A missing system Node.js, an old system Node.js, or an unrefreshed `PATH` therefore does not affect the MCP.

Only an empty directory, a directory with a valid ownership marker, or a recognized older installation can be updated. The installer refuses to overwrite or uninstall an unrelated directory.

## Command-line install and verification

Each Release also provides `Wawapi-Image-MCP-v<version>.zip.sha256`. Verify it before extraction when stronger provenance checking is required:

```powershell
Get-FileHash -LiteralPath .\Wawapi-Image-MCP-v1.3.0.zip -Algorithm SHA256
Get-Content -LiteralPath .\Wawapi-Image-MCP-v1.3.0.zip.sha256
```

`install.cmd` forwards advanced arguments to the installer:

```powershell
.\install.cmd -InstallRoot "E:\CodexTools\wawapi-image-mcp"
```

On a restricted network, download the matching `node-v24.19.0-win-x64.zip` or `node-v24.19.0-win-arm64.zip` from the official Node.js site first, then let the installer verify and use that local copy:

```powershell
.\install.cmd -NodeRuntimeArchive ".\node-v24.19.0-win-x64.zip"
```

The installer accepts these pinned official SHA-256 values:

| Architecture | File | SHA-256 |
|---|---|---|
| x64 | `node-v24.19.0-win-x64.zip` | `57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73` |
| arm64 | `node-v24.19.0-win-arm64.zip` | `8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f` |

The Windows-bundled runtime can also call the script directly:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -InstallRoot "E:\CodexTools\wawapi-image-mcp"
```

A custom installation directory must end in `wawapi-image-mcp`, and its full path must be no longer than 100 characters. Direct `install.ps1` calls return JSON; the double-click entry point uses human-readable output.

## MCP tools

| Tool | Purpose | Calls the image endpoint |
|---|---|---|
| `image_doctor` | Check local runtime and credentials and optionally probe the read-only model catalog; it does not probe the real generation channel | No |
| `list_image_models` | List image models currently exposed upstream | No |
| `explain_image_capability` | Explain time-point evidence for model, size, format, count, and reference-image support | No |
| `generate_image` | Generate and save images from text | Yes; may be billable |
| `edit_image` | Read a local reference and generate a transformed image | Yes; may be billable |
| `inspect_image` | Inspect real format, dimensions, byte count, and SHA-256 | No |

`generate_image` and `edit_image` return `data.result.images[]`. Each item includes:

- `path`: absolute local path.
- `file_uri`: standards-compliant file URI.
- `markdown`: Markdown suitable for conversation rendering.
- `width`, `height`, and `size`: dimensions read from the saved file.
- `format`: format detected from file signatures.
- `bytes` and `sha256`: integrity metadata.

`status=exact` means count, dimensions, and format match the request. `status=degraded` means the files are valid but at least one property changed; callers must inspect `deviations` and describe the actual result.

### Interpreting Doctor correctly

- `ready=true` means the local MCP can attempt one user-authorized image request. It does not guarantee upstream generation health.
- `catalog_status=verified` proves only that the read-only `/models` catalog responded.
- `catalog_status=unverified` is non-blocking and may come from DNS, proxy, TLS, timeout, gateway failure, or a misleading catalog response. It must not be reported as a generation-channel outage.
- Doctor does not send a potentially billable generation request, so `generation_channel_status` remains `not_probed`.
- Only `upstream_channel_unavailable` returned by `generate_image` or `edit_image` from `generation_submit`, `edit_submit`, or `generation_poll` is evidence that the real image channel is unavailable.
- Doctor normally finishes quickly and cannot prove that a long generation will not be cut off by the host. The latest installer separately sets Codex `tool_timeout_sec` to 600 and verifies it by reading the registration back.

## Capability boundaries

The bundled evidence snapshot records observations through 2026-08-04. It is evidence at a point in time, not a permanent service guarantee.

- Text-to-image `auto` prefers `gpt-image-2-high`.
- Reference-image `auto` prefers `gpt-image-2`.
- An explicitly requested model is never changed silently.
- The high, medium, and low variants have exact text-to-image evidence at 1024x1024, 2048x2048, and 3840x2160.
- The base model has historically returned 1254x1254 for a 2048x2048 request. The two latest real 3840x2160 requests on 2026-08-04 both returned 2048x1152, while older results include 1672x941 and exact 4K. Preserved aspect ratio does not mean requested resolution.
- PNG, JPEG, and WebP can be requested, but upstream may return a different format. The MCP saves and reports the actual file type.
- The requested count is 1–4. Upstream may return fewer files or a collage, so callers must check `actual_count`.
- The same base-model `count=2`, `1024x1024`, JPEG request returned one 1254x1254 PNG and later two independent 1024x1024 PNG files on 2026-08-04. Multi-image count and dimensions can vary, and both runs degraded JPEG to PNG.
- Multi-image calls to `explain_image_capability` must pass `count`. Its `requestedCount`, `expectedCountStatus`, and evidence `actualCount` fields keep single-image and multi-image evidence separate.
- `selection_scope=current_catalog` is the current catalog-aware selection. The `bundled_baseline` returned by `offline=true` is historical evidence only and must not be labeled as the current `auto` model when the two differ.
- Reference images must be PNG, JPEG, or WebP and no larger than 10 MB.
- A single HTTP 502, 503, or 524 is transient evidence, not proof that a model permanently lacks a capability.

See the [complete capability and degradation matrix](CAPABILITIES.en.md) for model, size, aspect-ratio, format, and reference-image evidence.

## Error contract

| Code | Meaning | Correct response |
|---|---|---|
| `api_key_missing` | No Key is available | Run the installer with `-ResetApiKey` |
| `invalid_api_key` | The Key failed authentication or is expired | Replace it and confirm image-service access |
| `upstream_channel_unavailable` | A real generation endpoint explicitly reports that the Key's image channel is unavailable | Wait or contact the Key provider; do not change prompt, size, or model to bypass it |
| `model_catalog_unverified` | The read-only model catalog produced no reliable conclusion | Do not treat it as a channel outage; proceed with one real request when the user asked for an image |
| `network_error` | A network-layer failure with `network_category`, `cause_code`, and `phase` | Diagnose DNS, refusal, reset, timeout, TLS, proxy, or routing precisely; do not relabel it as a channel outage |
| `rate_limit` | The upstream service explicitly rate-limited the request | Wait for the rate-limit window |
| `upstream_error` | Transient HTTP 502/503-class upstream failure | Let the user decide whether to authorize a later request |
| `upstream_timeout` | HTTP 524 or local wait timeout | Do not replay automatically because billing state may be ambiguous |
| `unsupported_size` | Upstream explicitly rejected the size | Use 1024x1024 or inspect capability evidence first |
| `reference_image_not_found` | The local reference path is missing and no upstream request occurred | Fix the path or provide a PNG, JPEG, or WebP; do not troubleshoot the API Key |
| `invalid_reference_image` | The local file is not a valid PNG, JPEG, or WebP and no upstream request occurred | Use a valid image; do not label this as an upstream-channel problem |
| `image_not_found` / `invalid_image_file` | `inspect_image` cannot find the file or the file is not a supported image | Check the local path and real file format |
| `reference_request_misparsed` | The reference route failed to parse a prompt that was sent | Preserve the prompt; require fresh authorization before another request |
| `model_unavailable` | The selected model is absent from the current catalog | List models, then use an available ID or `auto` |

An invalid Key, an unverified catalog, a network failure, and a real generation-channel outage are four different states. The MCP preserves the probe phase, target path, attempt count, HTTP status, network category, and safe low-level cause code so local or catalog failures are not mislabeled as generation-channel failures.

`MCP error -32001: Request timed out` is emitted by the Codex host when it stops waiting before the MCP returns; it is not the MCP `upstream_timeout` error above. The latest installer uses Codex's supported `tool_timeout_sec` setting to configure this MCP for 600 seconds. If the host message still appears, do not call it a channel outage and do not submit another potentially billable request without fresh authorization.

## Security, privacy, and billing

- The Base URL is fixed to `https://wawapii.com/v1`; configuration and environment variables cannot change it.
- The MCP prefers the ACL-protected state file, falls back only to `WAWAPI_API_KEY`, and never reads `OPENAI_API_KEY`.
- Source, release archives, tool results, and logs must not contain Keys, authorization headers, image Base64, or complete raw upstream responses.
- Prompts and reference images are sent to Wawapi. If upstream returns an image URL, the MCP downloads it through an SSRF-hardened path that rejects loopback, private, link-local, and unsafe redirected addresses.
- The project implements no telemetry. Runtime network calls are limited to Wawapi model/image endpoints and public image URLs returned upstream.
- The installer downloads managed Node.js only from a pinned official HTTPS URL and verifies embedded SHA-256 values for x64 and arm64; any mismatch stops installation.
- One explicit user image request authorizes one potentially billable call, not unrequested variants or unlimited retries.
- The MCP can retry once only when upstream explicitly indicates that work was not accepted, such as rate limiting or unavailable channel capacity.
- Ordinary HTTP 502/503/524 responses, network failures, local timeouts, and host cancellation are not replayed automatically.
- Existing destination files are not overwritten; a collision-safe name is created.

Do not place a Key in a Codex project, `config.toml`, README, issue, or chat. Revoke or rotate any Key that has been exposed.

## Update, change the Key, or uninstall

Extract the new release and double-click `install.cmd` again. It verifies the release package, preserves the stored Key, updates MCP and Skill registration, and repeats the read-only health check.

Change the Key:

```powershell
.\install.cmd -ResetApiKey
```

Uninstall:

```powershell
.\install.cmd -Uninstall
```

Uninstall removes only a verified project-owned installation directory, MCP registration, and Skill link. The protected Key in that directory is removed with it and cannot be recovered from the repository.

## Build and verify from source

The commands below are for contributors only. Users installing a GitHub Release by double-clicking do not need system Node.js or npm.

```powershell
npm ci
npm test
npm pack --dry-run
npm run build:release
```

Release artifacts are written under `release`: a versioned ZIP, its separate SHA-256 file, and an internal checksum manifest. Offline tests need no Key and do not contact Wawapi. `verify:live` sends a real image request and may incur charges; run it only with explicit authorization from the Key owner.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md). See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

The source is available under the [MIT License](LICENSE). Wawapi, OpenAI, Codex, and model names belong to their respective owners. The license grants no third-party trademark rights and does not alter external service terms.
