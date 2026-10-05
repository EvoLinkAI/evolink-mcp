import { basename } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fileStreamUpload, fileBase64Upload, fileUrlUpload } from '../services/file-client.js';
import {
  inspectBase64Upload,
  inspectLocalUpload,
  validateRemoteUploadURL,
  validateUploadDestination,
} from '../services/upload-policy.js';
import { WRITES, errorResult, failure, ok } from './shared.js';

const localFileSchema = {
  file_path: z.string().optional()
    .describe('Absolute path under EVOLINK_UPLOAD_ALLOWED_DIRS. Provide exactly one of file_path, base64_data, or file_url.'),
};

const contentSchema = {
  base64_data: z.string().optional()
    .describe('Base64 media data for small files. Data URLs carry their MIME type; raw base64 also needs mime_type.'),
  mime_type: z.string().optional()
    .describe('MIME type for raw base64_data; must match the file content.'),
  file_url: z.string().optional()
    .describe('Public HTTPS link to the media. Loopback, private-network and credential-bearing links are refused.'),
  upload_path: z.string().optional()
    .describe('Optional relative folder in EvoLink storage (no ..).'),
  file_name: z.string().optional()
    .describe('Optional plain file name (no folders).'),
};

interface UploadParams {
  file_path?: string;
  base64_data?: string;
  mime_type?: string;
  file_url?: string;
  upload_path?: string;
  file_name?: string;
}

export interface UploadFileOptions {
  /** Allow file_path uploads. The hosted service sets false: it must never read its own disk. */
  localFiles?: boolean;
}

const SHARED_DESCRIPTION = [
  'Store an image, audio or video file on EvoLink and get a link to pass to generate_* (for example in image_urls). Free; uses the file quota, and files are deleted after 72 hours.',
  'Max 100 MB; prefer file_url for large files.',
];

export function registerUploadFile(server: McpServer, options: UploadFileOptions = {}): void {
  const localFiles = options.localFiles ?? true;
  const sourceNames = localFiles ? 'file_path, base64_data, or file_url' : 'base64_data or file_url';

  const handler = async (params: UploadParams) => {
    const { base64_data, file_url, mime_type, upload_path, file_name } = params;
    const file_path = localFiles ? params.file_path : undefined;
    const sources = [file_path, base64_data, file_url].filter(Boolean);
    if (sources.length !== 1) {
      return failure(`Provide exactly one of ${sourceNames}.`, { error: { category: 'invalid_request' } });
    }

    // Local checks first: a refused source never reaches the network.
    let upload: () => ReturnType<typeof fileUrlUpload>;
    try {
      validateUploadDestination(upload_path, file_name);
      if (file_path) {
        const inspected = await inspectLocalUpload(file_path);
        upload = () => fileStreamUpload(
          inspected.realPath,
          inspected.size,
          inspected.mimeType,
          basename(inspected.realPath),
          upload_path,
          file_name,
        );
      } else if (base64_data) {
        inspectBase64Upload(base64_data, mime_type);
        upload = () => fileBase64Upload(base64_data, upload_path, file_name);
      } else {
        const url = validateRemoteUploadURL(file_url!);
        upload = () => fileUrlUpload(url, upload_path, file_name);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'the file was refused';
      return failure(`Upload refused: ${message}`, { error: { category: 'invalid_request', message } });
    }

    try {
      const result = await upload();
      const data = result.data;
      if (!data) throw new Error('File API returned no upload record');
      const lines = [
        'File uploaded.',
        `File URL: ${data.file_url}`,
        `Name: ${data.original_name} · ${(data.file_size / 1024).toFixed(1)} KB · ${data.mime_type}`,
        `Expires: ${data.expires_at}`,
      ];
      if (result.request_id) lines.push(`Request ID: ${result.request_id}`);
      lines.push('Next step: pass the File URL to a generate tool as input.');
      return ok(lines.join('\n'), {
        file_url: data.file_url,
        download_url: data.download_url,
        file_id: data.file_id,
        file_name: data.original_name,
        size_bytes: data.file_size,
        mime_type: data.mime_type,
        expires_at: data.expires_at,
        ...(result.request_id ? { request_id: result.request_id } : {}),
      });
    } catch (error) {
      return errorResult(error);
    }
  };

  if (localFiles) {
    server.registerTool('upload_file', {
      title: 'Upload a file',
      description: [...SHARED_DESCRIPTION, 'Local paths work only inside EVOLINK_UPLOAD_ALLOWED_DIRS.'].join(' '),
      inputSchema: { ...localFileSchema, ...contentSchema },
      annotations: { title: 'Upload a file', ...WRITES },
    }, handler);
  } else {
    server.registerTool('upload_file', {
      title: 'Upload a file',
      description: [...SHARED_DESCRIPTION, 'Accepts base64_data or a public file_url.'].join(' '),
      inputSchema: contentSchema,
      annotations: { title: 'Upload a file', ...WRITES },
    }, handler);
  }
}
