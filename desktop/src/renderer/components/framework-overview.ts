import type { InstantSuggestion } from './observation-types';

export interface FrameworkConcept {
  term: 'Delegation' | 'Description' | 'Discernment' | 'Diligence';
  explanation: string;
}

export interface FrameworkOverview {
  heading: string;
  concepts: FrameworkConcept[];
}

export function frameworkNavigationLabel(
  suggestion: InstantSuggestion,
  page: 0 | 1,
): string {
  if (page === 0) {
    return suggestion.kind === 'delegate'
      ? 'Show Description suggestion'
      : 'Show coaching suggestion';
  }
  return suggestion.kind === 'delegate'
    ? 'Back to Delegation and Description overview'
    : 'Back to 4D overview';
}

interface StageTaskRules {
  stage: string;
  task: string;
  rules: string;
}

function compactSentence(text: string, maxChars = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return normalized;
  if (normalized.length <= maxChars) {
    return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
  }
  const cutoff = normalized.lastIndexOf(' ', maxChars);
  const end = cutoff > maxChars / 2 ? cutoff : maxChars;
  return `${normalized.slice(0, end).replace(/[.,;:]$/, '')}…`;
}

function completeSentence(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return normalized;
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function parseStageTaskRules(prompt?: string): StageTaskRules | null {
  if (!prompt) return null;
  const match = prompt.match(
    /(?:^|\n)\s*Stage\s*:\s*([\s\S]*?)(?=\n\s*Task\s*:)[\s\S]*?\n\s*Task\s*:\s*([\s\S]*?)(?=\n\s*Rules\s*:)[\s\S]*?\n\s*Rules\s*:\s*([\s\S]*)$/i,
  );
  if (!match) return null;
  const [, stage, task, rules] = match.map((part) => part.trim());
  return stage && task && rules ? { stage, task, rules } : null;
}

function inferContentCompetency(
  suggestion: InstantSuggestion,
): 'Discernment' | 'Diligence' {
  const text = `${suggestion.title} ${suggestion.body ?? ''}`.toLowerCase();
  return text.includes('diligence') ? 'Diligence' : 'Discernment';
}

/**
 * Build the first 4D page from the generated suggestion itself. Delegate
 * suggestions already contain situation-grounded Stage/Task/Rules sections,
 * so using them here keeps the explanation aligned without another LLM call.
 */
export function buildFrameworkOverview(
  suggestion: InstantSuggestion,
  toolLabel: string,
  observation?: string,
): FrameworkOverview {
  if (suggestion.kind === 'delegate') {
    const sections = parseStageTaskRules(suggestion.prompt);
    if (sections) {
      return {
        heading: suggestion.title,
        concepts: [
          {
            term: 'Delegation',
            explanation: `Use ${toolLabel} to handle this part: ${compactSentence(sections.task)}`,
          },
          {
            term: 'Description',
            explanation: `Give it this context: ${compactSentence(sections.stage, 120)} Keep these requirements explicit: ${compactSentence(sections.rules)}`,
          },
        ],
      };
    }

    const task =
      observation?.trim() || suggestion.prompt?.trim() || suggestion.title;
    return {
      heading: suggestion.title,
      concepts: [
        {
          term: 'Delegation',
          explanation: `Use ${toolLabel} for this specific task: ${compactSentence(task)}`,
        },
        {
          term: 'Description',
          explanation:
            'Review the proposed prompt on the next page and adjust its context, desired result, and requirements before using it.',
        },
      ],
    };
  }

  const competency = inferContentCompetency(suggestion);
  return {
    heading: suggestion.title,
    concepts: [
      {
        term: competency,
        // This is the actual situation-grounded coaching explanation, not a
        // preview. Keep the complete text so the first 4D page never ends in
        // an unexplained ellipsis; the notification body scrolls if needed.
        explanation: completeSentence(
          suggestion.body || observation || suggestion.copyText,
        ),
      },
    ],
  };
}
