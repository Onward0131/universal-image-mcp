# Capability boundaries

Capabilities depend on the configured protocol, model, account, and provider. The project does not bundle a vendor's historical results as guarantees for other connections.

|Feature|OpenAI Images|Gemini|Chat image output|
|---|---|---|---|
|Generation|JSON POST|generateContent|chat/completions|
|Reference|One multipart image|One inlineData image|One image_url|
|Requested count|1–4, subject to model limits|1|1|
|Exact pixels|Forward size when specified|Provider extra_body only|Provider extra_body only|
|Output format|Forward when specified|Inspect returned bytes|Inspect returned bytes|
|Result|Base64, public URL, image Data URL|inlineData|Structured images or Markdown image links|

References support PNG/JPEG/WebP up to 10 MB. Masks, multiple references, arbitrary asynchronous jobs, and unrelated REST response schemas require further implementation.

`explain_image_capability` reports selection and uncertainty. `current_catalog` means directory discovery occurred; `configured_provider` means configuration was used. Neither guarantees size, format, or count support.

The saved bytes determine actual dimensions and format. `count_mismatch`, `size_mismatch`, and `format_mismatch` remain separate. Degraded output is preserved and explained without a second paid request.

Billable submissions are never replayed automatically. Read-only model discovery may retry. A timeout does not establish that no charge occurred.

See the [live test record](docs/LIVE-TEST.md) for narrowly scoped, authorized observations.
