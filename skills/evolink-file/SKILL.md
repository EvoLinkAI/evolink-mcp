---
name: evolink-file
description: Upload local files (images, audio, video) to Evolink cloud storage for use with AI generation. Get public URLs for image-to-image, image-to-video, and digital-human workflows.
---

# Evolink File — File Upload to Cloud

Upload local files (images, audio, video) to Evolink cloud storage and get public URLs. Use these URLs as input for image-to-image (`generate_image`), image-to-video (`generate_video`), or audio-driven digital-human generation.

> This is the file-upload view of evolink-media. Install the full skill for video, image, and music generation.

## Setup

Get your API key at [evolink.ai](https://evolink.ai/signup?utm_source=github[evolink.ai](https://evolink.ai/signup?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp)utm_medium=readme[evolink.ai](https://evolink.ai/signup?utm_source=github&utm_medium=readme&utm_campaign=evolink-media-mcp)utm_campaign=evolink-media-mcp) and set `EVOLINK_API_KEY`.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `upload_file` | Upload a local file and get a public URL (free) |

Uploaded files are deleted automatically after 72 hours; there is no tool to list or delete them.

## Supported Formats

- **Images:** JPEG, PNG, GIF, WebP (only these 4 types)
- **Audio:** All formats (`audio/*`) — MP3, WAV, FLAC, AAC, OGG, M4A, etc.
- **Video:** All formats (`video/*`) — MP4, MOV, AVI, MKV, WebM, FLV, etc.

One file per request, max **100MB**. Uploaded files expire after **72 hours**. Quota: 100 files (default) / 500 (VIP).

## Parameters

Provide exactly one of `file_path`, `base64_data`, or `file_url`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | One of three | Absolute path to a local file (stream upload). Local (stdio) installs only; the file must be inside `EVOLINK_UPLOAD_ALLOWED_DIRS` |
| `base64_data` | string | One of three | Base64-encoded file data (raw or Data URL format), for small files |
| `mime_type` | string | With raw base64 | MIME type of raw `base64_data` (a Data URL carries its own) |
| `file_url` | string | One of three | Public HTTPS URL of a remote file (server downloads directly) |
| `upload_path` | string | No | Server-side subdirectory |
| `file_name` | string | No | Custom file name |

## Workflow

1. Call `upload_file` with `file_path`, `base64_data`, or `file_url`
2. Get back `file_url` and `download_url` immediately (synchronous)
3. Put `file_url` in the `input` of a generate tool (`image_urls`, audio input, etc.)
4. Files are deleted automatically after 72 hours

## Examples

```
User: "I want to turn this photo into a video"
→ upload_file(file_path: "/path/to/photo.jpg")
→ estimate_cost(model: "seedance-1.5-pro", input: { prompt: "animate this photo", image_urls: ["<returned file_url>"] }) → quote the price, get the user's go-ahead
→ generate_video(model: "seedance-1.5-pro", input: { prompt: "animate this photo", image_urls: ["<returned file_url>"] })
→ get_task(task_id: "<task_id>") → waits up to 45 s; call again until completed, then share the links (they expire after 24 hours)
```

```
User: "Use this audio to drive a digital human"
→ upload_file(file_path: "/path/to/speech.mp3")
→ Use the returned file_url as audio input for digital-human generation
```
