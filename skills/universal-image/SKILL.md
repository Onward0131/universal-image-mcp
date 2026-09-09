---
name: universal-image
description: Generate and edit raster images through a configured local image-provider MCP, save them to disk, and display them in Codex. Use when the user requests this provider route or the main model API cannot accept image tool results. Supports OpenAI Images, Gemini, and chat image protocols.
---

# Universal image workflow

Use the registered `universal-image` MCP, or the explicitly selected instance of this server. Its result is text-only so the main model API does not need native image support. Never put API keys or image Base64 into the conversation.

1. Call `image_doctor`. Read the provider, api_format, configured_model, ready flag, issues, and next_actions. A configuration error needs a corrected connection, not a guessed domain or model.
2. `catalog_status=unverified` is non-blocking when `data.ready=true`; use the existing user authorization for one generation or edit. Doctor reports `generation_channel_status=not_probed`, so it cannot prove that generation is available or unavailable.
3. For unusual size, format, count, or reference requirements, consult `explain_image_capability` and [protocol limits](references/capabilities.md). Capability uncertainty is not proof of incompatibility. The project has no bundled provider-specific evidence.
4. Use `generate_image` for new images or `edit_image` for an authorized local reference. Preserve the user's requested parameters. `model=auto` uses the configured model or one unambiguous image candidate; on `model_required`, obtain the actual model ID.
5. Require `ok=true` and at least one `data.result.images[]` item. Display every returned `markdown` value. Report actual dimensions, format, count, and deviations without claiming the requested properties were met when they were not.

## Parameters

For `openai-images`, omit optional size, quality, format, background, and moderation unless requested or required by the selected model. For `gemini` and `openai-chat`, count must be 1; omit size/format or use `auto`. Provider aspect ratio and resolution are configured in trusted `extra_body`. If an exact-pixel or format requirement cannot be expressed, explain that before submitting rather than silently dropping it.

Editing takes one local PNG/JPEG/WebP file up to 10 MB. The host can pass its path even when the main model cannot see it. Do not claim visual inspection unless image vision is available. Multiple references and masks are currently unsupported.

## Billing and errors

Each generation or edit submits once. Do not add automatic retries, model changes, parameter changes, or provider changes after errors. A cancelled or timed-out request may already have been billed; fresh authorization is required before another submission unless the user already authorized a bounded test plan.

For `MCP error -32001: Request timed out`, explain that the host stopped waiting; do not label it an upstream outage. The installer configures and verifies 600 seconds, after which Codex must be restarted. For `invalid_api_key`, follow the masked installer/configuration route; never ask for a key in chat.

For installation problems, use the included installer and Doctor; do not send beginners into a separate Node.js installation workflow. The installer manages its own verified runtime. Do not modify other MCP instances to recover this one.
