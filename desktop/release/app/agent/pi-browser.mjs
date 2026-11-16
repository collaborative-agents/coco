import fs from 'node:fs';
import path from 'node:path';
import { createMcpExtension } from '@earendil-works/pi-coding-agent';

// Only this user-owned config is read; a workspace cannot launch MCP servers.
export function browserExtensions({ agentDir, cwd, requestApproval }) {
  const source = path.join(agentDir, 'browser.json');
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error(`Cannot read browser configuration: ${error.message}`);
  }
  if (config.enabled === false) return [];
  if (
    config.command !== undefined &&
    (typeof config.command !== 'string' || !path.isAbsolute(config.command))
  ) {
    throw new Error('browser.json command must be an absolute path to npx.');
  }
  return [
    createMcpExtension({
      loadConfig: () => ({
        errors: [],
        autoEnableCodemode: false,
        servers: [
          {
            name: 'browser',
            source,
            scope: 'extension',
            config: {
              // Electron's dev launcher preloads ts-node through NODE_OPTIONS.
              // That module is not available in the conversation's workspace.
              env: { NODE_OPTIONS: '' },
              command:
                config.command ||
                (process.platform === 'win32' ? 'npx.cmd' : 'npx'),
              args: [
                '-y',
                '@playwright/mcp@0.0.85',
                '--extension',
                '--background',
              ],
              exposure: 'direct',
            },
          },
        ],
      }),
    }),
    (pi) => {
      pi.on('tool_call', async (event, ctx) => {
        if (!event.toolName.startsWith('mcp__browser__')) return;
        if (ctx.signal?.aborted)
          return { block: true, reason: 'Operation aborted' };
        const allowed = await requestApproval?.(
          {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            directory: cwd,
            arguments: structuredClone(event.input),
          },
          ctx.signal,
        );
        if (ctx.signal?.aborted || allowed !== true)
          return {
            block: true,
            reason:
              'Browser action denied or stopped. Do not retry through another tool.',
          };
      });
    },
  ];
}
