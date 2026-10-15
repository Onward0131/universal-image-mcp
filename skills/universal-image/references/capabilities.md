# Protocol limits

- `openai-images`: generation JSON and single-reference multipart editing; count1–4 subject to the provider/model. Optional size, quality, output format, compression, background, moderation, and response format are forwarded only when selected.
- `gemini`: generateContent parts and inlineData; count1; imageConfig belongs in configured extra_body. Thinking images are filtered from final results.
- `openai-chat`: messages and image_url reference; count1; parses structured images and explicit Markdown image links.
- Reference files: PNG/JPEG/WebP, at most10MB. No masks or multiple references yet.
- API requests do not follow redirects. Returned image URLs must be public HTTP(S) addresses and pass address validation at each hop. Local gateways can return Base64.
- Catalog visibility is separate from generation permission. Explicit model IDs are preserved; multiple candidates are not guessed.
- No historical vendor matrix is bundled. Inspect the actual saved file for pixel dimensions, format, and count. Preserve and disclose degraded results.
