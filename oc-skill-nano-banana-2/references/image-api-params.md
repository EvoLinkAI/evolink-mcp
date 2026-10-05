# Nano Banana 2 — Image API Parameter Reference

Complete API parameter reference for Nano Banana 2 and Evolink image generation tools.

**Base URL:** `https://api.evolink.ai`
**Auth:** `Authorization: Bearer {EVOLINK_API_KEY}`
**All generation endpoints are async** — they return `task_id` immediately; wait for the result with `get_task` (up to 45 s per call). The MCP `generate_image` tool itself waits up to 40 s and returns the image links when ready.

---

## generate_image

**Endpoint:** `POST /v1/images/generations`

**MCP Tool Parameters** (paid — quote the price with `estimate_cost` and get the user's go-ahead first):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | **Yes** | Model ID from `search_models`. Use `gemini-3.1-flash-image-preview` for Nano Banana 2. |
| `input` | object | No | The model's parameters (see Parameters below), exactly as `get_model` lists them for that model. |
| `prompt` | string | No | Shortcut for `input.prompt`. |
| `client_request_id` | string | No | Idempotency key, 16–96 characters (letters, digits, `.`, `_`, `-`). Reuse it only to retry the same request after a network error or timeout, so it is not charged twice. |
| `max_cost_usd` | number | No | Spending cap: nothing is submitted if the estimated cost is higher. |

Waits up to 40 s and returns the image links when ready; otherwise returns a `task_id` for `get_task`.

Example `generate_image` arguments:

```json
{ "model": "gemini-3.1-flash-image-preview", "input": { "prompt": "A red fox in fresh snow", "size": "16:9" } }
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | **Yes** | — | Image description. Max 2000 characters. |
| `model` | enum | No | `gpt-image-1.5` | See Image Models below. Use `gemini-3.1-flash-image-preview` for Nano Banana 2. |
| `size` | string | No | model default | Ratio format: `1:1`, `16:9`, `9:16`, `2:3`, `3:2`, `4:3`, `3:4`, `4:5`, `5:4`, `21:9`. GPT models also accept pixel format: `1024x1024`, `1024x1536`, `1536x1024`. |
| `n` | integer 1–4 | No | 1 | Number of images to generate in one request. |
| `image_urls` | string[] | No | — | Reference image URLs for image-to-image or editing. Max 14 images. JPEG/PNG/WebP, ≤4MB each. |
| `mask_url` | string | No | — | PNG mask URL for partial inpainting. Only supported by `gpt-4o-image`. White areas = edit, black areas = keep. |

### Nano Banana 2 Models

| Model | Description | Key capability |
|-------|-------------|----------------|
| `gemini-3.1-flash-image-preview` | Nano Banana 2 — Google Gemini 3.1 Flash image generation | text-to-image, image-editing, fast |
| `nano-banana-2-lite` [BETA] | Nano Banana 2 Lite — lightweight fast generation | text-to-image, ultra-fast |

### All Image Models (20)

#### Stable (16)

| Model | Description | Key capability |
|-------|-------------|----------------|
| `gemini-3.1-flash-image-preview` | Nano Banana 2 — Google Gemini 3.1 Flash | text-to-image, image-editing, fast |
| `gpt-image-1.5` *(default)* | OpenAI GPT Image 1.5 — latest generation | text-to-image, image-editing |
| `gpt-image-1` | OpenAI GPT Image 1 — high-quality generation | text-to-image, image-editing |
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

#### Beta (4)

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

- **Supported:** JPEG, PNG, GIF, WebP
- **Max size:** 100MB
- **Expiry:** 72 hours
- **Quota:** 100 files (default) / 500 (VIP)

---

## Polling Strategy

| Type | Max wait |
|------|----------|
| Image | 5 minutes |

1. Submit `generate_image` → it returns the image links if they are ready within 40 s; otherwise you get a `task_id`
2. Call `get_task` → it waits up to 45 s per call (`wait_seconds`, default 30); inspect `status`
3. If `pending`/`processing`: call `get_task` again — no need to pause between calls
4. If `completed`: give the result links to the user right away (they expire after 24 hours)
5. If `failed`: read the error and its next step, surface to user
6. Never call `generate_image` again to check progress: that creates and charges a new task. After a lost connection, find the task with `list_tasks` before submitting again

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
| `image_processing_error` | No | Check format (JPG/PNG/WebP), size (<10MB), URL accessibility |
| `model_unavailable` | No | Use `search_models` to find alternatives |
| `generation_timeout` | Yes | Retry; simplify prompt if repeated |
| `quota_exceeded` | Yes | Top up at evolink.ai/dashboard/credits |
| `resource_exhausted` | Yes | Wait 30–60s, retry |
| `service_error` | Yes | Retry after 1 minute |
| `generation_failed_no_content` | Yes | Modify prompt, retry |
| `upstream_error` | Yes | Retry after 1 minute |
| `unknown_error` | Yes | Retry; contact support if persistent |
