// Desktop adapter for the pinned rpiv package. Internal imports are covered by
// the real-SDK integration test; upstream's default renderer requires a TUI.
import {
  registerAskUserQuestionTool,
  buildQuestionnaireResponse,
  buildToolResult,
} from '../node_modules/@juicesharp/rpiv-ask-user-question/ask-user-question.ts';
import { normalizeQuestionParams } from '../node_modules/@juicesharp/rpiv-ask-user-question/tool/normalize-params.ts';
import { validateQuestionnaire } from '../node_modules/@juicesharp/rpiv-ask-user-question/tool/validate-questionnaire.ts';
import { waitForAnswer } from './question-channel.mjs';

export default function (pi) {
  registerAskUserQuestionTool({
    ...pi,
    registerTool(definition) {
      pi.registerTool({
        ...definition,
        async execute(id, params, signal, update) {
          const typed = normalizeQuestionParams(params);
          const validation = validateQuestionnaire(typed);
          if (!validation.ok)
            return buildToolResult(validation.message, {
              answers: [],
              cancelled: true,
              error: validation.error,
            });
          const result = await waitForAnswer(
            pi.events,
            id,
            typed.questions,
            signal,
            () => {
              update?.({
                content: [],
                details: { waitingForAnswer: true, questions: typed.questions },
              });
            },
          );
          const response = buildQuestionnaireResponse(result, typed);
          return {
            ...response,
            details: { ...response.details, questions: typed.questions },
          };
        },
      });
    },
  });
}
