# Evolink Image API — Parameter Reference

Complete API parameter reference for image generation tools.

**Base URL:** `https://api.evolink.ai`
**Auth:** `Authorization: Bearer {EVOLINK_API_KEY}`
**All generation endpoints are async** — they return `task_id` immediately; wait for the result with `get_task` (up to 45 s per call). The MCP `generate_image` tool itself waits up to 40 s and returns the image links when ready.

---

## generate_image

**Endpoint:** `POST /v1/images/generations`

**MCP Tool Parameters** (paid — quote the price with `estimate_cost` and get the user's go-ahead first):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | **Yes** | Model ID from `search_models`. |
| `input` | object | No | The model's parameters (see Parameters below), exactly as `get_model` lists them for that model. |
| `prompt` | string | No | Shortcut for `input.prompt`. |
| `client_request_id` | string | No | Idempotency key, 16–96 characters (letters, digits, `.`, `_`, `-`). Reuse it only to retry the same request after a network error or timeout, so it is not charged twice. |
| `max_cost_usd` | number | No | Spending cap: nothing is submitted if the estimated cost is higher. |

Waits up to 40 s and returns the image links when ready; otherwise returns a `task_id` for `get_task`.

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

## get_task

**Endpoint:** `GET /v1/tasks/{task_id}`

**MCP Tool Parameters** (free):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | **Yes** | `task_id` returned by `generate_image`. |
| `wait_seconds` | integer 0–45 | No | How long the call may wait for the task to finish (default 30; 0 = quick check). |

Returns the status, progress, result links (they expire after 24 hours), the final charge, or the error with a next step. If the task is still running, call `get_task` again. `list_tasks` reads up to 50 tasks at once.

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Task ID |
| `model` | string | Model used for generation |
| `status` | enum | `pending` / `processing` / `completed` / `failed` |
| `progress` | integer | Progress percentage (0–100) |
| `results[]` | string[] | Direct result URLs — image download links |
| `result_data[].image_url` | string | Image download URL |
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

### File Constraints

- **Supported formats:** Images only — JPEG, PNG, GIF, WebP (4 types)
- **Max file size:** 100MB
- **File expiry:** 72 hours from upload (auto-deleted)
- **File quota:** 100 files (default) / 500 files (VIP)
- **Same-name override:** Uploading a file with an existing name overwrites the old file (may have cache delay)
- **1 file per request**

---

## Polling Strategy

`get_task` does the waiting: each call waits up to `wait_seconds` (0–45 s, default 30) for the task to finish, so there is no need to pause between calls.

### Max Wait

| Type | Max wait |
|------|----------|
| Image | 5 minutes |

### Algorithm

1. Submit `generate_image` → it returns the image links if they are ready within 40 s; otherwise you get a `task_id`
2. Call `get_task` with the `task_id` → inspect `status`
3. If `pending` or `processing`: call `get_task` again
4. If `completed`: give the result links to the user right away — they expire after 24 hours
5. If `failed`: show the error and its next step to the user
6. Never call `generate_image` again to check progress: that creates and charges a new task. After a lost connection, find the task with `list_tasks` before submitting again

### Timeout Handling

After 5 minutes, inform the user:
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

### File API Error Codes

| Code | Description | Resolution |
|------|-------------|------------|
| 400 | Bad request | Check parameters |
| 401 | Unauthorized | Verify API key |
| 403 | Forbidden | Check account permissions |
| 404 | File not found | Verify file_id |
| 40001 | File too large | Compress to under 100MB |
| 40002 | File type not allowed | Check supported formats (JPEG/PNG/GIF/WebP only) |
| 40003 | Quota exceeded | Uploaded files are deleted automatically after 72 hours; retry later |
| 40004 | URL download failed | Verify the source URL is accessible |
| 500 | Server error | Retry |
| 50001 | Storage service error | Retry after 1 minute |
