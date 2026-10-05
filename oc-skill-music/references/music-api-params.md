# Evolink Music API — Parameter Reference

Complete API parameter reference for music generation tools.

**Base URL:** `https://api.evolink.ai`
**Auth:** `Authorization: Bearer {EVOLINK_API_KEY}`
**All generation endpoints are async** — they return `task_id` immediately; wait for the result with `get_task` (up to 45 s per call).

---

## generate_audio

**Endpoint:** `POST /v1/audios/generations`

**MCP Tool Parameters** (paid — quote the price with `estimate_cost` and get the user's go-ahead first):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | **Yes** | Model ID from `search_models`. |
| `input` | object | No | The model's parameters (see Parameters below), exactly as `get_model` lists them for that model. |
| `prompt` | string | No | Shortcut for `input.prompt`. |
| `client_request_id` | string | No | Idempotency key, 16–96 characters (letters, digits, `.`, `_`, `-`). Reuse it only to retry the same request after a network error or timeout, so it is not charged twice. |
| `max_cost_usd` | number | No | Spending cap: nothing is submitted if the estimated cost is higher. |

Generates music, songs or speech. Returns a `task_id` at once; wait for it with `get_task`.

Example `generate_audio` arguments:

```json
{ "model": "suno-v4", "input": { "prompt": "A calm lo-fi beat for studying", "custom_mode": false, "instrumental": true } }
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | **Yes** | — | **Simple mode:** music description (max 500 chars). **Custom mode:** full lyrics with section tags like `[Verse]`, `[Chorus]`, `[Bridge]`, `[Outro]` (max 3000 chars for v4, 5000 for v4.5+). |
| `model` | enum | No | `suno-v4` | See Music Models below. |
| `custom_mode` | boolean | **Yes** | — | `false` = AI generates lyrics and style from your description. `true` = you control style, title, and lyrics. **No default — always set explicitly.** |
| `instrumental` | boolean | **Yes** | — | `true` = no vocals (instrumental only). `false` = with vocals. **No default — always set explicitly.** |
| `style` | string | No* | — | Comma-separated genre/mood/tempo tags. e.g. `"pop, upbeat, female vocals, 120bpm"`. *Required when `custom_mode: true`. |
| `title` | string | No* | — | Song title. Max 80 characters. *Required when `custom_mode: true`. |
| `negative_tags` | string | No | — | Styles to exclude. e.g. `"heavy metal, distorted guitar"`. |
| `vocal_gender` | enum | No | — | `m` (male) or `f` (female). Only effective in custom mode. |
| `duration` | integer | No | model decides | Target length in seconds (30–240s). |

### Two Modes

**Simple mode** (`custom_mode: false`):
- Provide a text description in `prompt`
- AI automatically generates lyrics, picks style and arrangement
- Easiest to use — just describe what you want

**Custom mode** (`custom_mode: true`):
- Write full lyrics in `prompt` with section markers: `[Verse]`, `[Chorus]`, `[Bridge]`, `[Outro]`
- Set `style` (genre/mood/tempo tags) and `title` (required in custom mode)
- Optionally set `vocal_gender` for male/female vocals

### Music Models (5, all BETA)

| Model | Quality | Max duration | Notes |
|-------|---------|--------------|-------|
| `suno-v4` *(default)* | Good | 120s | Balanced quality, economical |
| `suno-v4.5` | Better | 240s | Improved style control |
| `suno-v4.5plus` | Better | 240s | Extended v4.5 features |
| `suno-v4.5all` | Better | 240s | Full v4.5 feature set |
| `suno-v5` | Best | 240s | Studio-grade, best quality |

---

## get_task

**Endpoint:** `GET /v1/tasks/{task_id}`

**MCP Tool Parameters** (free):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | **Yes** | `task_id` returned by `generate_audio`. |
| `wait_seconds` | integer 0–45 | No | How long the call may wait for the task to finish (default 30; 0 = quick check). |

Returns the status, progress, result links (they expire after 24 hours), the final charge, or the error with a next step. If the task is still running, call `get_task` again. `list_tasks` reads up to 50 tasks at once.

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Task ID |
| `model` | string | Model used for generation |
| `status` | enum | `pending` / `processing` / `completed` / `failed` |
| `progress` | integer | Progress percentage (0–100) |
| `results[]` | string[] | Direct result URLs — audio file download links |
| `result_data[].audio_url` | string | Audio download URL |
| `result_data[].stream_audio_url` | string | Streaming audio URL |
| `result_data[].title` | string | Music track title |
| `result_data[].duration` | number | Duration in seconds |
| `result_data[].tags` | string | Auto-generated style tags |
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

- **Supported:** Audio — MP3, WAV, FLAC, AAC, OGG, M4A, etc.
- **Max size:** 100MB
- **Expiry:** 72 hours
- **Quota:** 100 files (default) / 500 (VIP)

---

## Polling Strategy

| Type | Max wait |
|------|----------|
| Music | 5 minutes |

1. Submit `generate_audio` → receive `task_id` at once
2. Call `get_task` → it waits up to 45 s per call (`wait_seconds`, default 30); inspect `status`
3. If `pending`/`processing`: call `get_task` again — no need to pause between calls
4. If `completed`: give the result links to the user right away (they expire after 24 hours)
5. If `failed`: read the error and its next step, surface to user
6. Never call `generate_audio` again to check progress: that creates and charges a new task. After a lost connection, find the task with `list_tasks` before submitting again

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
| `content_policy_violation` | No | Rephrase prompt or lyrics; avoid explicit content |
| `invalid_parameters` | No | Check param values — ensure `custom_mode` and `instrumental` are set |
| `model_unavailable` | No | Use `search_models` to find alternatives |
| `generation_timeout` | Yes | Retry; simplify prompt if repeated |
| `quota_exceeded` | Yes | Top up at evolink.ai/dashboard/credits |
| `resource_exhausted` | Yes | Wait 30–60s, retry |
| `service_error` | Yes | Retry after 1 minute |
| `generation_failed_no_content` | Yes | Modify prompt, retry |
| `upstream_error` | Yes | Retry after 1 minute |
| `unknown_error` | Yes | Retry; contact support if persistent |
