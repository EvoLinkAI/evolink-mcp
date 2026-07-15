import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from '../config.js';
import { apiRequest, formatUsageInfo } from '../services/api-client.js';
import { getModelNames } from '../data/models.js';

export function registerGenerateVideo(server: McpServer, config: ServerConfig): void {
  const modelNames = getModelNames('video');

  const schema = {
    prompt: z.string().max(5000).describe('Video description prompt'),
    model: z.enum(modelNames).default(modelNames[0])
      .describe('Video generation model'),
    duration: z.number().int().min(3).max(15).optional()
      .describe('Video duration in seconds. Range depends on model'),
    quality: z.enum(['480p', '720p', '1080p', '4k']).optional()
      .describe('Output video quality. Availability varies by model'),
    aspect_ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive']).optional()
      .describe('Video aspect ratio'),
    image_urls: z.array(z.string().url()).max(9).optional()
      .describe('Reference image URLs for image-to-video'),
    generate_audio: z.boolean().optional()
      .describe('Generate audio/sound effects. Supported by seedance-1.5-pro and veo3.1-pro'),
    confirm_cost: z.literal(true)
      .describe('Must be true to confirm submission of one potentially billable generation task.'),
  };

  server.tool(
    'generate_video',
    'Generate AI videos. Returns task_id immediately (video takes 2-5min). Use check_task to poll progress.',
    schema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (params) => {
      const { generate_audio, confirm_cost: _confirmed, ...rest } = params;
      const body: Record<string, unknown> = { ...rest };

      if (generate_audio !== undefined) {
        body.generate_audio = generate_audio;
      }

      const task = await apiRequest(config, {
        method: 'POST',
        path: '/v1/videos/generations',
        body,
        tool: 'generate_video',
      });

      const estimatedTime = task.task_info?.estimated_time ?? 180;
      const usageInfo = formatUsageInfo(task.usage);

      const lines = [
        `Video generation task submitted.`,
        `Task ID: ${task.id}`,
        `Status: pending`,
        `Estimated time: ~${estimatedTime}s`,
      ];
      if (task.request_id) lines.push(`Request ID: ${task.request_id}`);
      if (usageInfo) lines.push(usageInfo);
      lines.push('', `Use check_task with task_id "${task.id}" to poll progress.`);
      lines.push(`Recommended polling interval: 10-15 seconds.`);

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
