# Wawapi Capability Boundaries

English | [简体中文](CAPABILITIES.md)

These findings come from live requests observed between 2026-08-01 and 2026-08-04. They are point-in-time evidence, not permanent service guarantees. Always trust the actual format, dimensions, and count returned by the MCP. Do not generalize a single transient failure into a permanent capability boundary.

## Automatic model selection

- Text-to-image `auto` selects only from IDs returned by the current catalog, preferring `gpt-image-2-high`, `gpt-image-2-medium`, `gpt-image-2-low`, then `gpt-image-2`. If the current catalog exposes only the base model, `auto` must use it instead of forcing a historical variant.
- Reference-image `auto` also selects only from the current catalog and prefers `gpt-image-2`. The base model has successful reference-image evidence, while variant reference routes have been inconsistent.
- The upstream catalog can change between one and four models or become temporarily unverifiable. Read Doctor or the model list for every task; bundled evidence is historical and never freezes the current catalog.
- An explicitly requested model is preserved and is never switched silently after failure.
- Generation uses the synchronous endpoint to avoid adding asynchronous submission failure modes.

## Text-to-image evidence

| Model | 1024x1024 | 2048x2048 | 3840x2160 | Guidance |
|---|---|---|---|---|
| `gpt-image-2-high` | Exact PNG and WebP; `n=2` returned two exact JPEG files; one HTTP 524 on 2026-08-04 | Exact PNG | Exact PNG | Preferred for text-to-image |
| `gpt-image-2-medium` | Exact PNG | Exact PNG | Exact PNG | High-resolution fallback |
| `gpt-image-2-low` | Exact PNG | Exact PNG | Exact PNG | High-resolution fallback |
| `gpt-image-2` | Real requests on 2026-08-04 included HTTP 503 and an exact 1024x1024 PNG; the latest request was exact | Historical actual result of 1254x1254, a transient HTTP 502, and a real 2K HTTP 503 | The two latest real 3840x2160 requests on 2026-08-04 both degraded to 2048x1152 with exact 16:9; historical results also include 1672x941 and exact 4K | Selected by `auto` when it is the only current model; preferred for references |

Ordinary HTTP 502, 503, or 524 responses are transient upstream states and do not prove that a model is unsupported. Different model routes can have different states during the same time window.

## Reference-image evidence

| Model | Observed result | Interpretation |
|---|---|---|
| `gpt-image-2` | Historical 1024 request returned 1254x1254 PNG; a real `edit_image` request on 2026-08-04 returned an exact 1024x1024 PNG; a separate request returned HTTP 502 | Two independent real 2048x2048 reference WebP requests on 2026-08-04 preserved size but fell back to PNG; current routing can still vary |
| `gpt-image-2-high` | One HTTP 502 and a separate HTTP 400 that incorrectly reported a missing prompt | The variant multipart route has compatibility problems; prefer the base model |
| `gpt-image-2-low` | Two HTTP 502 observations | Support remains undetermined; this is not proof of permanent lack of support |
| `gpt-image-2-medium` | Two HTTP 502 observations | Support remains undetermined; this is not proof of permanent lack of support |

## Proportional degradation on the base model

Proportional degradation does not mean exact resolution. Every historical result below was smaller than requested:

| Requested | Actual | Aspect-ratio error | Classification |
|---|---|---:|---|
| 2048x2048 | 1254x1254 | 0.0000% | Proportional degradation |
| 3840x2160 | 1672x941 | 0.0531% | Proportional degradation |
| 2048x1080 | 1727x911 | 0.0304% | Proportional degradation |
| 2048x1152 | 1672x941 | 0.0531% | Proportional degradation |
| 2560x1440 | 1672x941 | 0.0531% | Proportional degradation |
| 4096x2160 | 3840x2016 | 0.4464% | Near-proportional degradation |
| 4096x2304 | 1672x941 | 0.0531% | Proportional degradation |
| 4096x4096 | 1254x1254 | 0.0000% | Proportional degradation |

An aspect-ratio error no greater than 1% is reported as preserved or rounding-preserved, but any pixel mismatch still produces `status=degraded`.

## Format, count, and file boundaries

- `gpt-image-2-high` has exact evidence for a 1024x1024 WebP and two independent 1024x1024 JPEG files.
- The base model has ignored WebP or JPEG requests and returned PNG. The MCP detects the real file signature and reports the format deviation.
- With only `gpt-image-2` in the current catalog, a real single `1024x1024 WebP` request on 2026-08-04 returned a pixel-exact PNG with `status=degraded`; it must not be described as WebP success.
- Two real `3840x2160` PNG requests on 2026-08-04 both returned `2048x1152` PNG with `status=degraded` but exact 16:9 aspect; preserved aspect ratio must not be described as 4K pixel success.
- Two independent real `2048x2048` reference WebP requests on 2026-08-04 both returned exact `2048x2048` PNG files with `status=degraded`; reference size success does not imply requested format success. When the requested output name ended in `.webp`, the MCP corrected it to `.png` to match the real bytes.
- The base model has historically turned `n=2` into one collage. The MCP always compares requested count with the number of real independent files.
- With only `gpt-image-2` in the current catalog, the same `count=2`, `1024x1024`, JPEG request returned one `1254x1254` PNG in an earlier 2026-08-04 run and two independent `1024x1024` PNG files in a later run. Both were `degraded` and neither produced JPEG, proving that count and dimensions can vary and that neither outcome is a fixed limit.
- `explain_image_capability` filters evidence by requested count. Multi-image preflight calls must pass `count` explicitly and inspect `expectedCountStatus` plus each evidence item's `actualCount`; single-image evidence must not be used to infer multi-image support.
- Online explanations use `selection_scope=current_catalog` for the current catalog-aware selection. Calls with `offline=true` return `selection_scope=bundled_baseline` and are historical evidence only. If the models differ, report the current selection first and never label the baseline model as the current `auto` result.
- Reference images must be PNG, JPEG, or WebP and no larger than 10 MB.
- URL results reject loopback, private, and link-local destinations at every redirect hop, with redirect, time, and 50 MB download limits.
- Existing output targets are never overwritten; the MCP selects a collision-safe filename.

## Doctor, retries, and channel state

- Doctor's network request probes only the `GET /models` catalog. It does not send a potentially billable image request. `ready=true` means the local runtime and Key have no definite blocker, while `generation_channel_status=not_probed` means the real generation channel was not tested.
- Catalog DNS, proxy, TLS, timeout, HTTP 502/503, or “no available channel” responses become a non-blocking `model_catalog_unverified` warning. They do not prove that the real generation channel is unavailable; when the user already authorized an image, the Skill proceeds with one real request.
- `network_error` preserves `phase`, `target`, `network_category`, and a safe `cause_code`. Categories cover DNS resolution, connection refusal, reset, connect timeout, TLS/certificate failure, proxy failure, unreachable networks, socket failure, and unknown network errors.
- Only `upstream_channel_unavailable` from the real `generate_image` or `edit_image` generation phase proves that the Key's image channel is currently unavailable.
- The MCP retries once only when upstream explicitly rejects the request before accepting work, such as HTTP 429 or an unavailable image channel or compatible account.
- Generation-phase `upstream_channel_unavailable` means the Key may be valid while its upstream image channel is unavailable. Wait for recovery or contact the Key provider; do not change the prompt, size, or model to bypass it.
- On 2026-08-04, real 1024x1024 and 2048x2048 requests against the current catalog each returned HTTP 503 `upstream_channel_unavailable`; a later multi-image request returned `ok=true` with degraded output. Catalog state and actual generation results must therefore be recorded independently for every request.
- Ordinary HTTP 502/503, HTTP 524, network interruption, and local timeout are not replayed automatically because billing state may be ambiguous.
- A real `2048x1080` wide request on 2026-08-04 returned HTTP 524 `upstream_timeout` with no file; it is recorded as a transient timeout, not permanent lack of wide-aspect support.
- Codex defaults MCP tool calls to 60 seconds. The installer sets `wawapi-image` `tool_timeout_sec` to 600 and verifies the value by reading the registration back. A host `MCP error -32001: Request timed out` is not a Doctor conclusion, an MCP `upstream_timeout`, or proof of a real channel outage, and it must not be replayed automatically while billing state is unknown.
