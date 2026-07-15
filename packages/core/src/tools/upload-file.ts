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

const schema = {
  file_path: z.string().optional()
    .describe('Absolute path under EVOLINK_UPLOAD_ALLOWED_DIRS. Provide exactly one of file_path, base64_data, or file_url.'),
  base64_data: z.string().optional()
    .describe('Base64 media data. Data URLs carry their MIME type; raw base64 also requires mime_type.'),
  mime_type: z.string().optional()
    .describe('Required MIME type for raw base64_data; must match the detected file signature.'),
  file_url: z.string().optional()
    .describe('Public HTTPS media URL. Loopback, private-address, and credential-bearing URLs are rejected.'),
  upload_path: z.string().optional()
    .describe('Optional relative server-side subdirectory without parent traversal'),
  file_name: z.string().optional()
    .describe('Optional plain file name without path separators'),
  confirm_upload: z.literal(true)
    .describe('Must be true to confirm that selected content may leave the local machine and be stored by EvoLink.'),
};

export function registerUploadFile(server: McpServer): void {
  server.tool(
    'upload_file',
    'Upload confirmed image/audio/video content to EvoLink cloud storage. Local paths are disabled unless EVOLINK_UPLOAD_ALLOWED_DIRS explicitly allows them. Max 100MB; files expire after 72h.',
    schema,
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params) => {
      const { file_path, base64_data, file_url, mime_type, upload_path, file_name } = params;
      const sources = [file_path, base64_data, file_url].filter(Boolean);
      if (sources.length !== 1) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Provide exactly one of file_path, base64_data, or file_url.' }],
          isError: true,
        };
      }

      try {
        validateUploadDestination(upload_path, file_name);
        let result;
        if (file_path) {
          const inspected = await inspectLocalUpload(file_path);
          result = await fileStreamUpload(
            inspected.realPath,
            inspected.size,
            inspected.mimeType,
            basename(inspected.realPath),
            upload_path,
            file_name,
          );
        } else if (base64_data) {
          inspectBase64Upload(base64_data, mime_type);
          result = await fileBase64Upload(base64_data, upload_path, file_name);
        } else {
          result = await fileUrlUpload(validateRemoteUploadURL(file_url!), upload_path, file_name);
        }

        const data = result.data;
        if (!data) throw new Error('File API returned no upload record');
        const lines = [
          'File uploaded successfully.',
          '',
          `File URL: ${data.file_url}`,
          `Download URL: ${data.download_url}`,
          `File ID: ${data.file_id}`,
          `File Name: ${data.original_name}`,
          `Size: ${(data.file_size / 1024).toFixed(1)} KB`,
          `Type: ${data.mime_type}`,
          `Expires: ${data.expires_at}`,
        ];
        if (result.request_id) lines.push(`Request ID: ${result.request_id}`);
        lines.push('', 'Use the File URL as generation input. Delete it when no longer needed.');
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown upload error';
        return {
          content: [{ type: 'text' as const, text: `Upload rejected or failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
