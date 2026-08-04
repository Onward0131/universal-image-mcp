---
name: wawapi-image
description: Generate or edit images through the registered Wawapi stdio MCP tools, save results locally, and display them in the conversation. Use when a user asks Codex or another Agent to create, render, draw, illustrate, transform, or edit a raster image, especially when the active model API has no native image generation, rejects image inputs, or can consume only text tool results.
---

# Wawapi Image

Use only the registered Wawapi MCP tools. Do not refuse an image request merely because the active model API lacks native image support. Do not replace this route with shell commands, direct HTTP requests, native image tools, or another image entry point.

## Required workflow

1. Before the first live image call in a task, call `image_doctor` with its default catalog probe.
2. Stop only when the tool is unavailable, the response itself fails, or `data.ready=false`. Report every item in `data.issues` and follow its `next_actions`; never request or reveal the API Key in chat.
3. When `data.ready=true`, continue with the image request. `data.catalog_status=unverified` and `model_catalog_unverified` are non-blocking: explain briefly that the read-only model catalog was not verified, then use the user's existing authorization for one real `generate_image` or `edit_image` call. Do not claim that the generation channel is up or down from Doctor alone; Doctor deliberately reports `generation_channel_status=not_probed`.
4. For 2K, 4K, an unusual aspect ratio, a non-PNG format, multiple images, or a reference image, read [references/capabilities.md](references/capabilities.md) and call `explain_image_capability` before generating. Pass the requested `size`, `format`, `count`, and reference-image state exactly; count evidence for one image must not be reused for a multi-image request. An unavailable catalog does not erase the bundled time-point evidence.
   - If the online explanation returns `no_matching_evidence`, call it once more with `offline=true` to retrieve bundled historical evidence.
   - Report `selection_scope=current_catalog` first as the current catalog-aware auto selection. Label `selection_scope=bundled_baseline` only as historical evidence; never replace or rename it as the current automatic model when the two selections differ.
5. Treat an explicit image request as authorization for one potentially billable generation call. Do not create unrequested variants.
6. Set `out` to a descriptive path inside the current workspace when possible. Relative paths resolve from the MCP process working directory.
7. On success, require `ok=true` and at least one `data.result.images[]` item. Display every returned `markdown` value in the conversation; use the absolute `path` only if the host cannot render that Markdown.
8. Report the actual file count, each image's `size` and `format`, and the result `status`. If `status=degraded`, report every deviation and never describe reduced output as the requested count, 2K, or 4K size.

Use `generate_image` for text-to-image requests. Use `edit_image` only when the user supplied a local PNG, JPEG, or WebP reference no larger than 10 MB. Keep `model=auto` unless the user requests a specific model. Auto chooses only from the current catalog: it prefers `gpt-image-2-high` for text generation and `gpt-image-2` for reference-image work when those IDs are currently present, and otherwise uses an available current ID.

## Interpreting health and channel evidence

- `ready=true` means the local MCP has a supported runtime and a configured, not-definitively-rejected Key. It means “safe to attempt the one user-authorized request,” not “the provider is guaranteed healthy.”
- `catalog_status=verified` proves only that the read-only `/models` catalog responded.
- `catalog_status=unverified` may result from DNS, proxy, TLS, timeout, gateway, or a misleading catalog response. It must not block an already-authorized image request.
- Treat `upstream_channel_unavailable` as generation-channel evidence only when `generate_image` or `edit_image` returns it from `generation_submit`, `edit_submit`, or `generation_poll`. A Doctor warning whose nested `probe_error.code` has that value is not generation-channel evidence.
- A successful real generation is stronger evidence than a failed catalog probe.

## Tool behavior

Generation tools return text JSON, absolute local paths, and Markdown. They never return an MCP `image` content block or image Base64. This lets a text-only model API call the tools and still display the saved result.

Use `inspect_image` when an existing file needs byte-level verification or a generation result lacks complete metadata. It reports real dimensions, format, byte count, and SHA-256 without sending the image to a model.

`explain_image_capability` is count-aware. For multiple-image requests, pass `count` explicitly and inspect `requestedCount`, `expectedCountStatus`, and each evidence item's `actualCount`; a size/format match alone does not prove that the requested number of independent files is supported.

The tool's `selection_scope` prevents catalog and historical evidence from being conflated. `current_catalog` describes the current discovery result. `bundled_baseline` is a dated fallback and must be introduced as historical evidence, especially when its `selectedModel` differs.

If the current model cannot visually inspect local images, display the file but do not claim visual verification. Distinguish file validation from visual judgment.

## Billing and retries

- A single approved generation call may internally retry once only after an explicit upstream rejection that indicates no work was accepted, such as channel capacity or rate limiting.
- If the host reports `user cancelled`, stop. Do not retry, switch tools, or infer that the provider received no request.
- If the host reports `MCP error -32001: Request timed out`, distinguish it from an MCP `upstream_timeout`: the host stopped waiting before the MCP returned. Do not label it as an upstream-channel outage and do not retry without fresh authorization because billing state is unknown. Tell Codex users to rerun the latest `install.cmd`, which configures and verifies a 600-second MCP tool timeout, then fully restart Codex.
- Do not automatically replay ordinary HTTP502/503/524, `network_error`, or local timeout failures because billing state may be ambiguous.
- Never submit another billable request after an error without fresh user authorization.

## Error handling

- MCP missing, `runtime_unsupported`, or an old Node.js report: tell the user to rerun the latest double-click `install.cmd`. The current installer provisions its own verified Node.js runtime; do not send beginners into a separate Node.js installation workflow.
- `api_key_missing`: tell the user to rerun the installer with `-ResetApiKey` or configure `WAWAPI_API_KEY` before launching Codex.
- `invalid_api_key`: stop and ask the user to update the Key or confirm it remains valid and has image-service access.
- Actual-generation `upstream_channel_unavailable`: do not change the prompt, size, or model. Advise waiting for recovery and contacting the Key provider.
- `network_error`: report `error.diagnostics.network_category`, `cause_code`, and `phase` when present. Describe the network layer precisely; do not relabel it as an upstream channel outage.
- `rate_limit`: stop after the MCP response and advise waiting for the limit window.
- `upstream_error` or HTTP502/503/524: treat as transient upstream state, not permanent lack of model support; do not replay automatically.
- `unsupported_size`: suggest `1024x1024` or call `explain_image_capability`; do not silently resubmit.
- `reference_image_not_found`: the local path is missing and no upstream image request occurred. Ask for the correct local PNG, JPEG, or WebP path; do not troubleshoot the API Key.
- `invalid_reference_image`: the local file is not a valid supported image and no upstream image request occurred. Ask for a valid PNG, JPEG, or WebP file.
- `image_not_found` or `invalid_image_file` from `inspect_image`: report the local path or file-format problem without describing it as an upstream failure.
- `reference_request_misparsed`: keep the non-empty prompt unchanged. Explain that the reference route misparsed the request; use another model only after fresh authorization.
- `model_unavailable`: call `list_image_models`, then omit `model` or select a returned ID after fresh authorization.

Never expose API Keys, authorization headers, image Base64, or raw upstream responses.
