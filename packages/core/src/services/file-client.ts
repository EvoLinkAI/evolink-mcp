import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { getApiKey } from '../config.js';
import { ApiHttpError } from './api-client.js';
import { classifyGatewayError, formatGatewayError } from './error-handler.js';
import {
  DEFAULT_WRITE_TIMEOUT_MS,
  evoHeaders,
  fetchWithTimeout,
  newRunId,
  parseRetryAfter,
  readJsonBody,
  responseRequestId,
  timeoutFromEnv,
} from './http-policy.js';

const FILES_API_BASE_URL = 'https://files-api.evolink.ai';

export interface FileUploadData {
  file_id: string;
  file_name: string;
  original_name: string;
  file_size: number;
  mime_type: string;
  upload_path: string;
  file_url: string;
  download_url: string;
  upload_time: string;
  expires_at: string;
}

interface FileApiResponse<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data?: T;
  request_id?: string;
}

function requestHeaders(tool: string): Record<string, string> {
  const runId = newRunId();
  return {
    'Authorization': `Bearer ${getApiKey()}`,
    ...evoHeaders(tool),
    'Idempotency-Key': runId,
    'X-Evo-Run-Id': runId,
  };
}

function apiError(status: number, data: unknown, headers: Headers): ApiHttpError {
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
  const info = classifyGatewayError(status, data, retryAfterMs, responseRequestId(headers));
  return new ApiHttpError(status, formatGatewayError(info), retryAfterMs, info.request_id, info);
}

async function parseResponse<T>(response: Response): Promise<FileApiResponse<T>> {
  const data = await readJsonBody(response);
  if (!response.ok) throw apiError(response.status, data, response.headers);
  const body = data as FileApiResponse<T>;
  if (body.success === false) {
    const status = typeof body.code === 'number' && body.code >= 400 && body.code < 600 ? body.code : 400;
    throw apiError(status, data, response.headers);
  }
  const requestId = responseRequestId(response.headers);
  if (!body.request_id && requestId) body.request_id = requestId;
  return body;
}

async function jsonUpload<T>(path: string, body: Record<string, string>): Promise<FileApiResponse<T>> {
  const response = await fetchWithTimeout(`${FILES_API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...requestHeaders('upload_file'), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutFromEnv('EVOLINK_MCP_WRITE_TIMEOUT_MS', DEFAULT_WRITE_TIMEOUT_MS));
  return parseResponse<T>(response);
}

export async function fileBase64Upload(
  base64Data: string,
  uploadPath?: string,
  fileName?: string,
): Promise<FileApiResponse<FileUploadData>> {
  const body: Record<string, string> = { base64_data: base64Data };
  if (uploadPath) body.upload_path = uploadPath;
  if (fileName) body.file_name = fileName;
  return jsonUpload('/api/v1/files/upload/base64', body);
}

function multipartField(name: string, value: string): Buffer {
  return Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
}

function safeDispositionValue(value: string): string {
  return value.replaceAll(/["\r\n]/g, '_');
}

export async function fileStreamUpload(
  filePath: string,
  fileSize: number,
  mime: string,
  originalName: string,
  uploadPath?: string,
  fileName?: string,
): Promise<FileApiResponse<FileUploadData>> {
  const boundary = `----evolink-${randomUUID()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeDispositionValue(originalName)}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const fields: Buffer[] = [];
  if (uploadPath) fields.push(multipartField('uploadPath', uploadPath));
  if (fileName) fields.push(multipartField('fileName', fileName));
  const tailParts: Buffer[] = [Buffer.from('\r\n')];
  for (const field of fields) {
    tailParts.push(Buffer.from(`--${boundary}\r\n`), field);
  }
  tailParts.push(Buffer.from(`--${boundary}--\r\n`));
  const suffix = Buffer.concat(tailParts);

  async function* multipartBody(): AsyncGenerator<Buffer> {
    yield prefix;
    for await (const chunk of createReadStream(filePath)) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    yield suffix;
  }

  const headers = requestHeaders('upload_file');
  headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
  headers['Content-Length'] = String(prefix.length + fileSize + suffix.length);
  const init = {
    method: 'POST',
    headers,
    body: Readable.from(multipartBody()) as unknown as RequestInit['body'],
    duplex: 'half' as const,
  };
  const response = await fetchWithTimeout(
    `${FILES_API_BASE_URL}/api/v1/files/upload/stream`,
    init as RequestInit,
    timeoutFromEnv('EVOLINK_MCP_WRITE_TIMEOUT_MS', DEFAULT_WRITE_TIMEOUT_MS),
  );
  return parseResponse<FileUploadData>(response);
}

export async function fileUrlUpload(
  fileUrl: string,
  uploadPath?: string,
  fileName?: string,
): Promise<FileApiResponse<FileUploadData>> {
  const body: Record<string, string> = { file_url: fileUrl };
  if (uploadPath) body.upload_path = uploadPath;
  if (fileName) body.file_name = fileName;
  return jsonUpload('/api/v1/files/upload/url', body);
}
