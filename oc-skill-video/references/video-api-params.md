# Evolink Video API — Parameter Reference

Complete API parameter reference for video generation tools.

**Base URL:** `https://api.evolink.ai`
**Auth:** `Authorization: Bearer {EVOLINK_API_KEY}`
**All generation endpoints are async** — they return `task_id` immediately; wait for the result with `get_task` (up to 45 s per call).

---

## generate_video

**Endpoint:** `POST /v1/videos/generations`

**MCP Tool Parameters** (paid — quote the price with `estimate_cost` and get the user's go-ahead first):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | **Yes** | Model ID from `search_models`. |
| `input` | object | No | The model's parameters (see Parameters below), exactly as `get_model` lists them for that model. |
| `prompt` | string | No | Shortcut for `input.prompt`. |
| `client_request_id` | string | No | Idempotency key, 16–96 characters (letters, digits, `.`, `_`, `-`). Reuse it only to retry the same request after a network error or timeout, so it is not charged twice. |
| `max_cost_usd` | number | No | Spending cap: nothing is submitted if the estimated cost is higher. |

Returns a `task_id` at once (videos take minutes); wait for it with `get_task`. The `generate_audio` parameter below is a video `input` field, not the `generate_audio` tool.

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

#### Stable (26)

| Model | Description | Key features |
|-------|-------------|--------------|
| `seedance-1.5-pro` *(default)* | ByteDance Seedance 1.5 Pro | t2v, i2v, first-last-frame, 4–12s, 1080p, audio |
| `seedance-2.0` | ByteDance Seedance 2.0 (placeholder, API pending) | t2v, i2v |
| `doubao-seedance-1.0-pro-fast` | ByteDance Seedance 1.0 Pro Fast | t2v, fast |
| `sora-2-preview` | OpenAI Sora 2 Preview | t2v, i2v, 1080p |
| `kling-o3-text-to-video` | Kuaishou Kling O3 — text-to-video | t2v, 3–15s, 1080p |
| `kling-o3-image-to-video` | Kuaishou Kling O3 — image-to-video | i2v, 1080p |
| `kling-o3-reference-to-video` | Kuaishou Kling O3 — reference-guided | ref2v, 1080p |
| `kling-o3-video-edit` | Kuaishou Kling O3 — video editing | video-edit, 1080p |
| `kling-v3-text-to-video` | Kuaishou Kling V3 — text-to-video | t2v, 1080p |
| `kling-v3-image-to-video` | Kuaishou Kling V3 — image-to-video | i2v, 1080p |
| `kling-o1-image-to-video` | Kuaishou Kling O1 — image-to-video | i2v |
| `kling-o1-video-edit` | Kuaishou Kling O1 — video editing | video-edit |
| `kling-o1-video-edit-fast` | Kuaishou Kling O1 — fast video editing | video-edit, fast |
| `kling-custom-element` | Kuaishou Kling — custom element video | custom-element |
| `veo-3.1-generate-preview` | Google Veo 3.1 — generation preview | t2v, 1080p |
| `veo-3.1-fast-generate-preview` | Google Veo 3.1 — fast generation preview | t2v, fast, 1080p |
| `MiniMax-Hailuo-2.3` | MiniMax Hailuo 2.3 — high-quality | t2v, 1080p |
| `MiniMax-Hailuo-2.3-Fast` | MiniMax Hailuo 2.3 Fast | t2v, fast, 1080p |
| `MiniMax-Hailuo-02` | MiniMax Hailuo 02 | t2v |
| `wan2.5-t2v-preview` | Alibaba WAN 2.5 — t2v preview | t2v |
| `wan2.5-i2v-preview` | Alibaba WAN 2.5 — i2v preview | i2v |
| `wan2.5-text-to-video` | Alibaba WAN 2.5 — text-to-video | t2v |
| `wan2.5-image-to-video` | Alibaba WAN 2.5 — image-to-video | i2v |
| `wan2.6-text-to-video` | Alibaba WAN 2.6 — text-to-video | t2v |
| `wan2.6-image-to-video` | Alibaba WAN 2.6 — image-to-video | i2v |
| `wan2.6-reference-video` | Alibaba WAN 2.6 — reference-guided | ref2v |

#### Beta (11)

| Model | Description | Key features |
|-------|-------------|--------------|
| `sora-2` [BETA] | OpenAI Sora 2 — cinematic video | t2v, i2v, 1080p |
| `sora-2-pro` [BETA] | OpenAI Sora 2 Pro — premium cinematic | t2v, i2v, 1080p, premium |
| `sora-2-beta-max` [BETA] | OpenAI Sora 2 Beta Max — maximum quality | t2v, 1080p, max-quality |
| `sora-character` [BETA] | OpenAI Sora Character — character-consistent | t2v, character-consistency |
| `veo3.1-pro` [BETA] | Google Veo 3.1 Pro — top-tier cinematic + audio | t2v, 1080p, audio |
| `veo3.1-fast` [BETA] | Google Veo 3.1 Fast — fast high-quality | t2v, fast, 1080p |
| `veo3.1-fast-extend` [BETA] | Google Veo 3.1 Fast Extend — extended generation | t2v, fast, extend |
| `veo3` [BETA] | Google Veo 3 — cinematic video | t2v, 1080p |
| `veo3-fast` [BETA] | Google Veo 3 Fast — fast video | t2v, fast |
| `grok-imagine-text-to-video` [BETA] | xAI Grok Imagine — text-to-video | t2v |
| `grok-imagine-image-to-video` [BETA] | xAI Grok Imagine — image-to-video | i2v |

---

## get_task

**Endpoint:** `GET /v1/tasks/{task_id}`

**MCP Tool Parameters** (free):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | **Yes** | `task_id` returned by `generate_video`. |
| `wait_seconds` | integer 0–45 | No | How long the call may wait for the task to finish (default 30; 0 = quick check). |

Returns the status, progress, result links (they expire after 24 hours), the final charge, or the error with a next step. If the task is still running, call `get_task` again. `list_tasks` reads up to 50 tasks at once.

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Task ID |
| `model` | string | Model used for generation |
| `status` | enum | `pending` / `processing` / `completed` / `failed` |
| `progress` | integer | Progress percentage (0–100) |
| `results[]` | string[] | Direct result URLs — video MP4 download links |
| `result_data[].video_url` | string | Video download URL |
| `task_info.estimated_time` | integer | Estimated seconds remaining |
| `task_info.can_cancel` | boolean | Whether the task can be cancelled |
| `usage.credits_reserved` | number | Credits charged for this task |
| `error.code` | string | Error code (only when `status: "failed"`) |
| `error.message` | string | Error description (only when `status: "failed"`) |

All result URLs expire in **24 hours**.

### Status Values

| Status | Meaning | Action |
|--------|---------|--------|
| `pending` | Queued, not started | Call `get_task` again |
| `processing` | Generation in progress | Call `get_task` again, report `progress` |
| `completed` | Generation finished | Extract URLs from `results[]` or `result_data[]` and give them to the user right away |
| `failed` | Generation failed | Read `error.code` + `error.message` and the next step, surface to user |

---

## File Management API

**Base URL:** `https://files-api.evolink.ai`
**Auth:** `Authorization: Bearer {EVOLINK_API_KEY}` (same API key)

All file endpoints are **synchronous**.

### upload_file

| Method | Endpoint | Use when |
|--------|----------|----------|
| Base64 | `POST /api/v1/files/upload/base64` | Have base64 data |
| Stream | `POST /api/v1/files/upload/stream` | Have a local file |
| URL | `POST /api/v1/files/upload/url` | Have a remote URL |

**MCP Tool Parameters** (free; provide exactly one of `file_path`, `base64_data`, `file_url`):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | One of three | Absolute local file path; local (stdio) installs only, inside `EVOLINK_UPLOAD_ALLOWED_DIRS` |
| `base64_data` | string | One of three | Base64-encoded data (raw or Data URL), for small files |
| `mime_type` | string | With raw base64 | MIME type of raw `base64_data` |
| `file_url` | string | One of three | Public HTTPS URL |

### File Constraints

- **Supported:** Images (JPEG/PNG/GIF/WebP), Video (all formats)
- **Max size:** 100MB
- **Expiry:** 72 hours
- **Quota:** 100 files (default) / 500 (VIP)

---

## Polling Strategy

| Type | Max wait |
|------|----------|
| Video | 10 minutes |

1. Submit `generate_video` → receive `task_id` at once
2. Call `get_task` → it waits up to 45 s per call (`wait_seconds`, default 30); inspect `status`
3. If `pending`/`processing`: call `get_task` again — no need to pause between calls
4. If `completed`: give the video links to the user right away (they expire after 24 hours)
5. If `failed`: read the error and its next step, surface to user
6. Never call `generate_video` again to check progress: that creates and charges a new task. After a lost connection, find the task with `list_tasks` before submitting again

---

## Error Codes

### HTTP Status Codes

| Code | Meaning | Resolution |
|------|---------|------------|
| 400 | Bad request | Check required fields; revise prompt |
| 401 | Invalid API key | Verify at evolink.ai/dashboard/keys |
| 402 | Insufficient credits | Top up at evolink.ai/dashboard/credits |
| 429 | Rate limit exceeded | Wait 30–60s, retry |
| 500 | Server error | Retry after 1 minute |
| 503 | Service unavailable | Retry after 1–2 minutes |

### Task Error Codes

| Code | Retryable | Resolution |
|------|-----------|------------|
| `content_policy_violation` | No | Rephrase prompt; avoid NSFW, violence, real person names |
| `invalid_parameters` | No | Check param values against model limits |
| `image_dimension_mismatch` | No | Resize image to match requested aspect ratio |
| `image_processing_error` | No | Check format (JPG/PNG/WebP), size (<30MB), URL accessibility |
| `model_unavailable` | No | Use `search_models` to find alternatives |
| `generation_timeout` | Yes | Retry; simplify prompt or lower resolution if repeated |
| `quota_exceeded` | Yes | Top up at evolink.ai/dashboard/credits |
| `resource_exhausted` | Yes | Wait 30–60s, retry |
| `service_error` | Yes | Retry after 1 minute |
| `generation_failed_no_content` | Yes | Modify prompt, retry |
| `upstream_error` | Yes | Retry after 1 minute |
| `unknown_error` | Yes | Retry; contact support if persistent |
