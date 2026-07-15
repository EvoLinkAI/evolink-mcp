import { open, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import {
  delimiter,
  extname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.wma': 'audio/x-ms-wma', '.opus': 'audio/opus', '.amr': 'audio/amr',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv', '.ts': 'video/mp2t', '.m4v': 'video/mp4',
  '.3gp': 'video/3gpp',
};

const ALLOWED_MIME_TYPES = new Set(Object.values(MIME_BY_EXTENSION));
const ASF_HEADER = Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex');

export interface LocalUploadInfo {
  realPath: string;
  size: number;
  mimeType: string;
}

export interface Base64UploadInfo {
  mimeType: string;
  decodedBytes: number;
}

function startsWith(buffer: Buffer, signature: Buffer | string): boolean {
  const expected = typeof signature === 'string' ? Buffer.from(signature) : signature;
  return buffer.subarray(0, expected.length).equals(expected);
}

function hasFtyp(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
}

function matchesMimeSignature(mime: string, buffer: Buffer): boolean {
  switch (mime) {
    case 'image/jpeg': return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/png': return startsWith(buffer, Buffer.from('89504e470d0a1a0a', 'hex'));
    case 'image/gif': return startsWith(buffer, 'GIF87a') || startsWith(buffer, 'GIF89a');
    case 'image/webp': return startsWith(buffer, 'RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'audio/mpeg': return startsWith(buffer, 'ID3') || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
    case 'audio/wav': return startsWith(buffer, 'RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
    case 'audio/flac': return startsWith(buffer, 'fLaC');
    case 'audio/aac': return buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0;
    case 'audio/ogg': return startsWith(buffer, 'OggS');
    case 'audio/opus': return startsWith(buffer, 'OggS') && buffer.includes(Buffer.from('OpusHead'));
    case 'audio/mp4': return hasFtyp(buffer);
    case 'audio/x-ms-wma': return startsWith(buffer, ASF_HEADER);
    case 'audio/amr': return startsWith(buffer, '#!AMR');
    case 'video/mp4': case 'video/quicktime': case 'video/3gpp': return hasFtyp(buffer);
    case 'video/x-msvideo': return startsWith(buffer, 'RIFF') && buffer.subarray(8, 12).toString('ascii') === 'AVI ';
    case 'video/x-matroska': case 'video/webm': return startsWith(buffer, Buffer.from('1a45dfa3', 'hex'));
    case 'video/x-flv': return startsWith(buffer, 'FLV');
    case 'video/x-ms-wmv': return startsWith(buffer, ASF_HEADER);
    case 'video/mp2t': return buffer[0] === 0x47 || buffer[188] === 0x47;
    default: return false;
  }
}

function withinRoot(candidate: string, root: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

export async function inspectLocalUpload(
  filePath: string,
  allowedDirectories = process.env.EVOLINK_UPLOAD_ALLOWED_DIRS,
): Promise<LocalUploadInfo> {
  if (!isAbsolute(filePath)) {
    throw new Error('file_path must be absolute');
  }
  const configuredRoots = (allowedDirectories ?? '').split(delimiter).map(value => value.trim()).filter(Boolean);
  if (configuredRoots.length === 0) {
    throw new Error('local uploads are disabled; set EVOLINK_UPLOAD_ALLOWED_DIRS to explicit trusted directories');
  }
  if (configuredRoots.some(root => !isAbsolute(root))) {
    throw new Error('EVOLINK_UPLOAD_ALLOWED_DIRS may contain only absolute directories');
  }

  const candidate = await realpath(resolve(filePath));
  const roots = await Promise.all(configuredRoots.map(root => realpath(resolve(root))));
  if (!roots.some(root => withinRoot(candidate, root))) {
    throw new Error('file_path resolves outside EVOLINK_UPLOAD_ALLOWED_DIRS');
  }
  const fileStat = await stat(candidate);
  if (!fileStat.isFile()) throw new Error('file_path must resolve to a regular file');
  if (fileStat.size <= 0 || fileStat.size > MAX_UPLOAD_BYTES) {
    throw new Error(`local file size must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes`);
  }

  const mimeType = MIME_BY_EXTENSION[extname(candidate).toLowerCase()];
  if (!mimeType) throw new Error('local file extension is not an allowed image, audio, or video type');
  const handle = await open(candidate, 'r');
  try {
    const header = Buffer.alloc(512);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (!matchesMimeSignature(mimeType, header.subarray(0, bytesRead))) {
      throw new Error(`local file content does not match declared MIME type ${mimeType}`);
    }
  } finally {
    await handle.close();
  }
  return { realPath: candidate, size: fileStat.size, mimeType };
}

export function inspectBase64Upload(value: string, declaredMime?: string): Base64UploadInfo {
  let payload = value.trim();
  let mimeType = declaredMime?.trim().toLowerCase();
  const dataUrl = payload.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (dataUrl) {
    const dataMime = dataUrl[1].trim().toLowerCase();
    if (mimeType && mimeType !== dataMime) throw new Error('mime_type conflicts with the base64 Data URL');
    mimeType = dataMime;
    payload = dataUrl[2];
  }
  if (!mimeType) throw new Error('mime_type is required for raw base64_data');
  if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error(`MIME type ${mimeType} is not allowed`);

  const compact = payload.replaceAll(/\s/g, '');
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('base64_data is not valid base64');
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.floor(compact.length * 3 / 4) - padding;
  if (decodedBytes <= 0 || decodedBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`decoded base64 size must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes`);
  }
  const header = Buffer.from(compact.slice(0, 1_024), 'base64');
  if (!matchesMimeSignature(mimeType, header)) {
    throw new Error(`base64 content does not match declared MIME type ${mimeType}`);
  }
  return { mimeType, decodedBytes };
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value))) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

export function validateRemoteUploadURL(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('file_url must be a valid absolute URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('file_url must use HTTPS and must not contain credentials');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateIPv4(hostname)
    || (isIP(hostname) === 6 && (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')))) {
    throw new Error('file_url must not target a loopback or private address');
  }
  return parsed.toString();
}

export function validateUploadDestination(uploadPath?: string, fileName?: string): void {
  if (uploadPath) {
    if (uploadPath.length > 256 || isAbsolute(uploadPath) || uploadPath.split(/[\\/]+/).some(part => part === '..')) {
      throw new Error('upload_path must be a relative server path without parent traversal');
    }
  }
  if (fileName && (fileName.length > 255 || fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..')) {
    throw new Error('file_name must be a plain file name without path separators');
  }
}
