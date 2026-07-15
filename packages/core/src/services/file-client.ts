import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { getApiKey } from '../config.js';
import { ApiHttpError, withRetry } from './api-client.js';
import {
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_WRITE_TIMEOUT_MS,
  PaidRequestOutcomeUnknownError,
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

export interface FileListData {
  total: number;
  files: Array<{
    file_id: string;
    file_name: string;
    file_size: number;
    upload_time: string;
  }>;
}

export interface FileQuotaData {
  user_group: string;
  used_files: number;
  max_files: number;
  remain_files: number;
}

interface FileApiResponse<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data?: T;
  request_id?: string;
}

function requestHeaders(tool: string, idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${getApiKey()}`,
    'X-Evo-Client': 'mcp',
    'X-Evo-Client-Version': process.env.npm_package_version ?? 'dev',
    'X-Evo-Tool': tool,
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
    headers['X-Evo-Run-Id'] = idempotencyKey;
  }
  return headers;
}

function formatFileError(status: number, data: unknown): string {
  const body = data as Record<string, unknown>;
  if (body?.msg && typeof body.msg === 'string') {
    return `File API error (${body.code ?? status}): ${body.msg}`;
  }
  if (body?.message && typeof body.message === 'string') {
    return `File API HTTP ${status}: ${body.message}`;
  }
  return `File API HTTP ${status}`;
}

async function parseResponse<T>(response: Response): Promise<FileApiResponse<T>> {
  const data = await readJsonBody(response);
  const requestId = responseRequestId(response.headers);
  if (!response.ok) {
    throw new ApiHttpError(
      response.status,
      formatFileError(response.status, data),
      parseRetryAfter(response.headers.get('retry-after')),
      requestId,
    );
  }
  const body = data as FileApiResponse<T>;
  if (body.success === false) {
    throw new ApiHttpError(body.code, formatFileError(body.code, data), undefined, requestId);
  }
  if (!body.request_id && requestId) body.request_id = requestId;
  return body;
}

async function jsonRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  tool: string,
  body?: Record<string, string>,
  idempotencyKey?: string,
): Promise<FileApiResponse<T>> {
  const headers = requestHeaders(tool, idempotencyKey);
  if (body) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetchWithTimeout(`${FILES_API_BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }, timeoutFromEnv(
      method === 'GET' ? 'EVOLINK_MCP_READ_TIMEOUT_MS' : 'EVOLINK_MCP_WRITE_TIMEOUT_MS',
      method === 'GET' ? DEFAULT_READ_TIMEOUT_MS : DEFAULT_WRITE_TIMEOUT_MS,
    ));
  } catch (error) {
    if (method !== 'GET') throw new PaidRequestOutcomeUnknownError(error);
    throw error;
  }
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
  return jsonRequest('POST', '/api/v1/files/upload/base64', 'upload_file', body, newRunId());
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

  const headers = requestHeaders('upload_file', newRunId());
  headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
  headers['Content-Length'] = String(prefix.length + fileSize + suffix.length);
  const init = {
    method: 'POST',
    headers,
    body: Readable.from(multipartBody()) as unknown as RequestInit['body'],
    duplex: 'half' as const,
  };
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${FILES_API_BASE_URL}/api/v1/files/upload/stream`,
      init as RequestInit,
      timeoutFromEnv('EVOLINK_MCP_WRITE_TIMEOUT_MS', DEFAULT_WRITE_TIMEOUT_MS),
    );
  } catch (error) {
    throw new PaidRequestOutcomeUnknownError(error);
  }
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
  return jsonRequest('POST', '/api/v1/files/upload/url', 'upload_file', body, newRunId());
}

export async function fileDelete(fileId: string): Promise<FileApiResponse> {
  return jsonRequest('DELETE', `/api/v1/files/${fileId}`, 'delete_file', undefined, newRunId());
}

export async function fileList(page = 1, pageSize = 20): Promise<FileApiResponse<FileListData>> {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return withRetry(
    () => jsonRequest('GET', `/api/v1/files/list?${query}`, 'list_files'),
    3,
    1_500,
  );
}

export async function fileQuota(): Promise<FileApiResponse<FileQuotaData>> {
  return withRetry(
    () => jsonRequest('GET', '/api/v1/files/quota', 'list_files'),
    3,
    1_500,
  );
}
