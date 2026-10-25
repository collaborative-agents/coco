// Reuse pi-context-view's analysis without its terminal UI or synthetic prompts.
// Pinned internal imports are exercised by the real-SDK integration test.
import { buildSessionContext } from '@earendil-works/pi-coding-agent';
import { buildNativeSnapshot } from '../node_modules/pi-context-view/src/capture.ts';
import {
  computeUsage,
  toReportedUsage,
} from '../node_modules/pi-context-view/src/usage.ts';

export default function (pi) {
  let context;
  let options = {};
  pi.on('before_agent_start', (event, ctx) => {
    context = ctx;
    options = event.systemPromptOptions;
  });
  pi.on('session_start', (_event, ctx) => {
    context = ctx;
  });
  pi.events.on('coco:context:read', (request) => {
    if (!context) return;
    try {
      const snapshot = buildNativeSnapshot({
        systemPrompt: context.getSystemPrompt(),
        options,
        allTools: pi.getAllTools(),
        activeToolNames: pi.getActiveTools(),
      });
      request.snapshot = computeUsage({
        snapshot,
        messages: buildSessionContext(
          context.sessionManager.getEntries(),
          context.sessionManager.getLeafId(),
        ).messages,
        reported: toReportedUsage(context.getContextUsage()),
        modelLabel: context.model?.name ?? context.model?.id,
      });
    } catch (error) {
      request.error = error instanceof Error ? error.message : String(error);
    }
  });
}
