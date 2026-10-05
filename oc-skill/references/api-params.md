# Evolink Media API — Parameter Reference

Complete API parameter reference for all Evolink Media MCP tools.

**Base URL:** `https://api.evolink.ai`
**Auth:** `Authorization: Bearer {EVOLINK_API_KEY}`
**All generation endpoints are async** — they return `task_id` immediately; wait for the result with `get_task` (up to 45 s per call). The MCP `generate_image` tool itself waits up to 40 s and returns the image links when ready.

---

## generate_image

**Endpoint:** `POST /v1/images/generations`

**MCP Tool Parameters** (all three generate tools take the same arguments; paid — quote the price with `estimate_cost` and get the user's go-ahead first):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | **Yes** | Model ID from `search_models`. |
| `input` | object | No | The model's parameters (see Parameters below), exactly as `get_model` lists them for that model. |
| `prompt` | string | No | Shortcut for `input.prompt`. |
| `client_request_id` | string | No | Idempotency key, 16–96 characters (letters, digits, `.`, `_`, `-`). Reuse it only to retry the same request after a network error or timeout, so it is not charged twice. |
| `max_cost_usd` | number | No | Spending cap: nothing is submitted if the estimated cost is higher. |

`generate_image` waits up to 40 s and returns the image links when ready; otherwise it returns a `task_id` for `get_task`.

Example `generate_image` arguments:

```json
{ "model": "gpt-image-1.5", "input": { "prompt": "A red fox in fresh snow", "size": "1024x1024" } }
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | **Yes** | — | Image description. Max 2000 characters. |
| `model` | enum | No | `gpt-image-1.5` | See Image Models below. |
| `size` | string | No | model default | Aspect ratio format: `1:1`, `16:9`, `9:16`, `2:3`, `3:2`, `4:3`, `3:4`, `4:5`, `5:4`, `21:9`. Pixel format (gpt-4o-image only): `1024x1024`, `1024x1536`, `1536x1024`. |
| `n` | integer 1–4 | No | 1 | Number of images to generate in one request. |
| `image_urls` | string[] | No | — | Reference image URLs for image-to-image or editing. Max 14 images. JPEG/PNG/WebP, ≤4MB each. |
| `mask_url` | string | No | — | PNG mask URL for partial inpainting. Only supported by `gpt-4o-image`. White areas = edit, black areas = keep. |

### Image Models (20)

#### Stable

| Model | Description | Key capability |
|-------|-------------|----------------|
| `gpt-image-1.5` *(default)* | OpenAI GPT Image 1.5 — latest generation | text-to-image, image-editing |
| `gpt-image-1` | OpenAI GPT Image 1 — high-quality generation | text-to-image, image-editing |
| `gemini-3.1-flash-image-preview` | Nano Banana 2 — Google Gemini 3.1 Flash | text-to-image, image-editing, fast |
| `gemini-3-pro-image-preview` | Google Gemini 3 Pro — image generation preview | text-to-image |
| `z-image-turbo` | Z-Image Turbo — fastest generation | text-to-image, ultra-fast |
| `doubao-seedream-4.5` | ByteDance Seedream 4.5 — photorealistic | text-to-image, photorealistic |
| `doubao-seedream-4.0` | ByteDance Seedream 4.0 — high-quality | text-to-image |
| `doubao-seedream-3.0-t2i` | ByteDance Seedream 3.0 — text-to-image | text-to-image |
| `doubao-seededit-4.0-i2i` | ByteDance Seededit 4.0 — image-to-image editing | image-editing |
| `doubao-seededit-3.0-i2i` | ByteDance Seededit 3.0 — image-to-image editing | image-editing |
| `qwen-image-edit` | Alibaba Qwen — instruction-based editing | image-editing, instruction-based |
| `qwen-image-edit-plus` | Alibaba Qwen Plus — advanced editing | image-editing, instruction-based |
| `wan2.5-t2i-preview` | Alibaba WAN 2.5 — text-to-image preview | text-to-image |
| `wan2.5-i2i-preview` | Alibaba WAN 2.5 — image-to-image preview | image-editing |
| `wan2.5-text-to-image` | Alibaba WAN 2.5 — text-to-image | text-to-image |
| `wan2.5-image-to-image` | Alibaba WAN 2.5 — image-to-image | image-editing |

#### Beta

| Model | Description | Key capability |
|-------|-------------|----------------|
| `gpt-image-1.5-lite` [BETA] | OpenAI GPT Image 1.5 Lite — fast lightweight | text-to-image, fast |
| `gpt-4o-image` [BETA] | OpenAI GPT-4o Image — best prompt understanding + editing | text-to-image, image-editing, best-quality |
| `gemini-2.5-flash-image` [BETA] | Google Gemini 2.5 Flash — fast image generation | text-to-image, fast |
| `nano-banana-2-lite` [BETA] | Nano Banana 2 Lite — versatile general-purpose | text-to-image, fast |

---

## generate_video

**Endpoint:** `POST /v1/videos/generations`

**MCP tool:** same arguments as `generate_image` (`model`, `input`, `prompt`, `client_request_id`, `max_cost_usd`); paid. Returns a `task_id` at once (videos take minutes); wait for it with `get_task`. The `generate_audio` parameter below is a video `input` field, not the `generate_audio` tool.

Example `generate_video` arguments:

```json
{ "model": "seedance-1.5-pro", "input": { "prompt": "A paper boat drifting down a rainy street", "duration": 5, "quality": "720p", "aspect_ratio": "16:9" } }
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | **Yes** | — | Video description. Max 5000 characters. |
| `model` | enum | No | `seedance-1.5-pro` | See Video Models below. |
| `duration` | integer | No | model default | Duration in seconds. Range varies by model. |
| `quality` | enum | No | model default | `480p` / `720p` / `1080p` / `4k`. Availability varies by model. |
| `aspect_ratio` | enum | No | `16:9` | `16:9` / `9:16` / `1:1` / `4:3` / `3:4` / `21:9` / `adaptive` |
| `image_urls` | string[] | No | — | Reference images. **1 image** = image-to-video. **2 images** = first-frame + last-frame (`seedance-1.5-pro` only). Max 9 images. JPEG/PNG/WebP, ≤30MB each. |
| `generate_audio` | boolean | No | model default | Auto-generate synchronized audio. Supported by `seedance-1.5-pro` (default: `true`) and `veo3.1-pro` [BETA]. |

### Video Models (37)

#### Stable

| Model | Description | Key features |
|-------|-------------|--------------|
| `seedance-1.5-pro` *(default)* | ByteDance Seedance 1.5 Pro | text-to-video, image-to-video, first-last-frame, 4–12s, 1080p, audio-generation |
| `seedance-2.0` | ByteDance Seedance 2.0 (placeholder, API pending) | text-to-video, image-to-video |
| `doubao-seedance-1.0-pro-fast` | ByteDance Seedance 1.0 Pro Fast | text-to-video, fast |
| `sora-2-preview` | OpenAI Sora 2 Preview | text-to-video, image-to-video, 1080p |
| `kling-o3-text-to-video` | Kuaishou Kling O3 — text-to-video | text-to-video, 3–15s, 1080p |
| `kling-o3-image-to-video` | Kuaishou Kling O3 — image-to-video | image-to-video, 1080p |
| `kling-o3-reference-to-video` | Kuaishou Kling O3 — reference-guided | reference-to-video, 1080p |
| `kling-o3-video-edit` | Kuaishou Kling O3 — video editing | video-edit, 1080p |
| `kling-v3-text-to-video` | Kuaishou Kling V3 — text-to-video | text-to-video, 1080p |
| `kling-v3-image-to-video` | Kuaishou Kling V3 — image-to-video | image-to-video, 1080p |
| `kling-o1-image-to-video` | Kuaishou Kling O1 — image-to-video | image-to-video |
| `kling-o1-video-edit` | Kuaishou Kling O1 — video editing | video-edit |
| `kling-o1-video-edit-fast` | Kuaishou Kling O1 — fast video editing | video-edit, fast |
| `kling-custom-element` | Kuaishou Kling — custom element video | custom-element |
| `veo-3.1-generate-preview` | Google Veo 3.1 — generation preview | text-to-video, 1080p |
| `veo-3.1-fast-generate-preview` | Google Veo 3.1 — fast generation preview | text-to-video, fast, 1080p |
| `MiniMax-Hailuo-2.3` | MiniMax Hailuo 2.3 — high-quality | text-to-video, 1080p |
| `MiniMax-Hailuo-2.3-Fast` | MiniMax Hailuo 2.3 Fast | text-to-video, fast, 1080p |
| `MiniMax-Hailuo-02` | MiniMax Hailuo 02 | text-to-video |
| `wan2.5-t2v-preview` | Alibaba WAN 2.5 — text-to-video preview | text-to-video |
| `wan2.5-i2v-preview` | Alibaba WAN 2.5 — image-to-video preview | image-to-video |
| `wan2.5-text-to-video` | Alibaba WAN 2.5 — text-to-video | text-to-video |
| `wan2.5-image-to-video` | Alibaba WAN 2.5 — image-to-video | image-to-video |
| `wan2.6-text-to-video` | Alibaba WAN 2.6 — text-to-video | text-to-video |
| `wan2.6-image-to-video` | Alibaba WAN 2.6 — image-to-video | image-to-video |
| `wan2.6-reference-video` | Alibaba WAN 2.6 — reference-guided | reference-to-video |

#### Beta

| Model | Description | Key features |
|-------|-------------|--------------|
| `sora-2` [BETA] | OpenAI Sora 2 — cinematic video | text-to-video, image-to-video, 1080p |
| `sora-2-pro` [BETA] | OpenAI Sora 2 Pro — premium cinematic | text-to-video, image-to-video, 1080p, premium |
| `sora-2-beta-max` [BETA] | OpenAI Sora 2 Beta Max — maximum quality | text-to-video, 1080p, max-quality |
| `sora-character` [BETA] | OpenAI Sora Character — character-consistent | text-to-video, character-consistency |
| `veo3.1-pro` [BETA] | Google Veo 3.1 Pro — top-tier cinematic + audio | text-to-video, 1080p, audio-generation |
| `veo3.1-fast` [BETA] | Google Veo 3.1 Fast — fast high-quality | text-to-video, fast, 1080p |
| `veo3.1-fast-extend` [BETA] | Google Veo 3.1 Fast Extend — extended generation | text-to-video, fast, extend |
| `veo3` [BETA] | Google Veo 3 — cinematic video | text-to-video, 1080p |
| `veo3-fast` [BETA] | Google Veo 3 Fast — fast video | text-to-video, fast |
| `grok-imagine-text-to-video` [BETA] | xAI Grok Imagine — text-to-video | text-to-video |
| `grok-imagine-image-to-video` [BETA] | xAI Grok Imagine — image-to-video | image-to-video |

---

## generate_audio

**Endpoint:** `POST /v1/audios/generations`

**MCP tool:** same arguments as `generate_image` (`model`, `input`, `prompt`, `client_request_id`, `max_cost_usd`); paid. Generates music, songs or speech. Returns a `task_id` at once; wait for it with `get_task`.

Example `generate_audio` arguments:

```json
{ "model": "suno-v4", "input": { "prompt": "A calm lo-fi beat for studying", "custom_mode": false, "instrumental": true } }
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | **Yes** | — | **Simple mode:** music description (max 500 chars). **Custom mode:** full lyrics with section tags like `[Verse]`, `[Chorus]`, `[Bridge]`, `[Outro]` (max 3000 chars for v4, 5000 for v4.5+). |
| `model` | enum | No | `suno-v4` | See Music Models below. |
| `custom_mode` | boolean | **Yes** | — | `false` = AI generates lyrics and style from your description. `true` = you control style, title, and lyrics. **No default — must always be set.** |
| `instrumental` | boolean | **Yes** | — | `true` = no vocals (instrumental only). `false` = with vocals. **No default — must always be set.** |
| `style` | string | No* | — | Comma-separated genre/mood/tempo tags. e.g. `"pop, upbeat, female vocals, 120bpm"`. *Required when `custom_mode: true`. |
| `title` | string | No* | — | Song title. Max 80 characters. *Required when `custom_mode: true`. |
| `negative_tags` | string | No | — | Styles to exclude. e.g. `"heavy metal, distorted guitar"`. |
| `vocal_gender` | enum | No | — | `m` (male) or `f` (female). Only effective in custom mode. |

### Music Models (5, all [BETA])

| Model | Quality | Max duration | Notes |
|-------|---------|--------------|-------|
| `suno-v4` *(default)* | Good | 120s | Balanced quality, economical |
| `suno-v4.5` | Better | 240s | Improved style control |
| `suno-v4.5plus` | Better | 240s | Extended v4.5 features |
| `suno-v4.5all` | Better | 240s | Full v4.5 feature set |
| `suno-v5` | Best | 240s | Studio-grade, best quality |

---

## Digital Human

**Note:** Digital human generation uses `omnihuman-1.5` — audio-driven digital human video generation with lip-sync, portrait animation, and auto-masking support. Call it with `generate_video`; `get_model` lists its inputs.

---

## get_task

**Endpoint:** `GET /v1/tasks/{task_id}`

**MCP Tool Parameters** (free):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | **Yes** | `task_id` returned by a generate tool. |
| `wait_seconds` | integer 0–45 | No | How long the call may wait for the task to finish (default 30; 0 = quick check). |

Returns the status, progress, result links (they expire after 24 hours), the final charge, or the error with a next step. If the task is still running, call `get_task` again.

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Task ID |
| `model` | string | Model used for generation |
| `status` | enum | `pending` / `processing` / `completed` / `failed` |
| `progress` | integer | Progress percentage (0–100) |
| `results[]` | string[] | Direct result URLs — images, video MP4, or audio files |
| `result_data[].video_url` | string | Video download URL |
| `result_data[].image_url` | string | Image download URL |
| `result_data[].audio_url` | string | Audio file download URL |
| `result_data[].stream_audio_url` | string | Streaming audio URL |
| `result_data[].title` | string | Music track title (music only) |
| `result_data[].duration` | number | Duration in seconds |
| `result_data[].tags` | string | Auto-generated style tags (music only) |
| `task_info.estimated_time` | integer | Estimated seconds remaining |
| `task_info.can_cancel` | boolean | Whether the task can be cancelled |
| `usage.credits_reserved` | number | Credits charged for this task |
| `usage.billing_rule` | string | Billing rule applied |
| `error.code` | string | Error code (only when `status: "failed"`) |
| `error.message` | string | Error description (only when `status: "failed"`) |
| `error.type` | string | Error type (only when `status: "failed"`) |

**Note:** All result URLs expire in **24 hours**. Download promptly.

### Status Values

| Status | Meaning | Action |
|--------|---------|--------|
| `pending` | Queued, not started | Call `get_task` again |
| `processing` | Generation in progress | Call `get_task` again, report `progress` |
| `completed` | Generation finished | Extract URLs from `results[]` or `result_data[]` and give them to the user right away |
| `failed` | Generation failed | Read `error.code` + `error.message` and the next step, surface to user |

---

## Lookup and Account Tools

All free and read-only. There is no cancel tool: tasks run to completion, and failed tasks are refunded.

| Tool | Arguments | Returns |
|------|-----------|---------|
| `search_models` | `type` (`image` / `video` / `audio` / `all`, default `all`), `query` (keywords), `limit` (1–50, default 20) | Model IDs with a starting price |
| `get_model` | `model` | Input parameters (required, allowed values, ranges, defaults), prices and an example input |
| `estimate_cost` | `model`, `input` (the object you plan to pass to the generate tool) | Whether the input is valid, the estimated cost, and whether the balance covers it. Nothing is submitted |
| `list_tasks` | `task_ids` (up to 50), or `status` / `type` / `since` (ISO time or `30m` / `2h` / `1d`) / `limit` | Tasks with result links. Use it to recover tasks after a lost connection before submitting again |
| `check_balance` | none | Account balance, what this key has spent, and the top-up link https://evolink.ai/dashboard/credits (68 credits ≈ $1) |

---

## File Management API

**Base URL:** `https://files-api.evolink.ai` (different from generation API)
**Auth:** `Authorization: Bearer {EVOLINK_API_KEY}` (same API key)

All file endpoints are **synchronous** — no task polling needed.

### upload_file

Three upload methods available:

| Method | Endpoint | Content-Type | Use when |
|--------|----------|-------------|----------|
| Base64 | `POST /api/v1/files/upload/base64` | `application/json` | Have base64 data |
| Stream | `POST /api/v1/files/upload/stream` | `multipart/form-data` | Have a local file |
| URL | `POST /api/v1/files/upload/url` | `application/json` | Have a remote URL |

**MCP Tool Parameters** (free; provide exactly one of `file_path`, `base64_data`, `file_url`):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | One of three | Absolute local file path. Uses stream upload internally. Local (stdio) installs only, and the file must be inside `EVOLINK_UPLOAD_ALLOWED_DIRS`. |
| `base64_data` | string | One of three | Base64-encoded data (raw or Data URL format). For small files. |
| `mime_type` | string | With raw base64 | MIME type of raw `base64_data` (a Data URL carries its own). |
| `file_url` | string | One of three | Public HTTPS URL. Server downloads and stores it. Prefer this for large files. |
| `upload_path` | string | No | Server-side subdirectory for organizing uploads. |
| `file_name` | string | No | Custom file name. |

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `data.file_id` | string | Unique file identifier (use for delete) |
| `data.file_name` | string | Stored file name |
| `data.original_name` | string | Original file name |
| `data.file_size` | number | File size in bytes |
| `data.mime_type` | string | MIME type (e.g., `image/jpeg`) |
| `data.file_url` | string | Public URL — use as `image_urls` input |
| `data.download_url` | string | Direct download URL |
| `data.upload_time` | string | Upload timestamp |
| `data.expires_at` | string | Expiration timestamp |

### Delete a File (REST only)

There is no MCP tool for deleting or listing files; uploaded files are deleted automatically after 72 hours.

**Endpoint:** `DELETE /api/v1/files/{file_id}`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_id` | string | Yes | File ID to delete |

### List Files & Quota (REST only)

**Endpoints:** `GET /api/v1/files/list` + `GET /api/v1/files/quota`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Page number (default: 1) |
| `pageSize` | integer | No | Files per page (default: 20, max: 100) |

### File API Constraints

- **Supported formats:**
  - Images: JPEG, PNG, GIF, WebP (only these 4 types)
  - Audio: all formats (`audio/*`) — MP3, WAV, FLAC, AAC, OGG, M4A, etc.
  - Video: all formats (`video/*`) — MP4, MOV, AVI, MKV, WebM, FLV, etc.
- **Max file size:** 100MB
- **File expiry:** 72 hours from upload (auto-deleted)
- **File quota:** 100 files (default) / 500 files (VIP)
- **Same-name override:** Uploading a file with an existing name overwrites the old file (may have cache delay)
- **1 file per request**

### File API Error Codes

| Code | Description | Resolution |
|------|-------------|------------|
| 400 | Bad request | Check parameters |
| 401 | Unauthorized | Verify API key |
| 403 | Forbidden | Check account permissions |
| 404 | File not found | Verify file_id |
| 40001 | File too large | Compress to under 100MB |
| 40002 | File type not allowed | Check supported formats |
| 40003 | Quota exceeded | Uploaded files are deleted automatically after 72 hours; retry later |
| 40004 | URL download failed | Verify the source URL is accessible |
| 500 | Server error | Retry |
| 50001 | Storage service error | Retry after 1 minute |

---

## Polling Strategy

`get_task` does the waiting: each call waits up to `wait_seconds` (0–45 s, default 30) for the task to finish, so there is no need to pause between calls.

### Max Wait

| Type | Max wait |
|------|----------|
| Image | 5 minutes |
| Video | 10 minutes |
| Music | 5 minutes |

### Algorithm

1. Submit with `generate_image`, `generate_video` or `generate_audio`. `generate_image` returns the image links if they are ready within 40 s; otherwise (and always for video and audio) you get a `task_id`
2. Call `get_task` with the `task_id` → inspect `status`
3. If `pending` or `processing`: call `get_task` again
4. If `completed`: give the result links to the user right away — they expire after 24 hours
5. If `failed`: show the error and its next step to the user
6. Never call a generate tool again to check progress: that creates and charges a new task. After a lost connection, find the task with `list_tasks` before submitting again

### Timeout Handling

After max wait time, inform the user:
*"This is taking longer than expected. The task ID is `{task_id}` — you can check it again later."*

---

## Error Codes

### HTTP Status Codes

| Code | Meaning | Resolution |
|------|---------|------------|
| 400 | Bad request — invalid params or content blocked | Check required fields; revise prompt |
| 401 | Invalid or missing API key | Verify `EVOLINK_API_KEY` at evolink.ai/dashboard/keys |
| 402 | Insufficient credits | Top up at evolink.ai/dashboard/credits |
| 403 | Access denied | Check account permissions |
| 404 | Resource not found | Verify `task_id` is correct |
| 413 | Payload too large | Compress images to under 4MB |
| 429 | Rate limit exceeded | Wait 30–60 seconds, then retry |
| 500 | Internal server error | Retry after 1 minute |
| 502 | Upstream unavailable | Retry after 1 minute |
| 503 | Service unavailable | Retry after 1–2 minutes |

### Task Error Codes (from get_task when status is "failed")

| Code | Retryable | Description | Resolution |
|------|-----------|-------------|------------|
| `content_policy_violation` | No | Prompt blocked by safety filter | Rephrase; avoid explicit violence, NSFW, real person names |
| `invalid_parameters` | No | Invalid parameter values | Check param values against model limits |
| `image_dimension_mismatch` | No | Image dimensions don't match request | Resize image to match requested aspect ratio |
| `image_processing_error` | No | Failed to process input image | Check format (JPG/PNG/WebP), size (<10MB), URL accessibility |
| `model_unavailable` | No | Model temporarily offline | Call `search_models` to find available alternatives |
| `generation_timeout` | Yes | Generation exceeded time limit | Retry; simplify prompt or lower resolution if repeated |
| `quota_exceeded` | Yes | Account credits depleted | Wait, then retry. Top up at evolink.ai/dashboard/credits |
| `resource_exhausted` | Yes | Server resources temporarily full | Wait 30–60 seconds and retry |
| `service_error` | Yes | Internal service error | Retry after 1 minute |
| `generation_failed_no_content` | Yes | Generation produced no output | Modify prompt and retry |
| `upstream_error` | Yes | Upstream provider error | Retry after 1 minute |
| `rate_limited` | Yes | Rate limit at task level | Wait 30 seconds and retry |
| `unknown_error` | Yes | Unclassified error | Retry; contact support if persistent |
