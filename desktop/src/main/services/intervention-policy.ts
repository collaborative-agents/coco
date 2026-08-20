export interface InterventionEvent {
  status?: string;
  type?: string;
  intervention_source?: string;
}

const ACTIONABLE_STATUSES = new Set([
  'stuck',
  'mistake',
  'inefficient',
  'ai_struggle',
  'discernment_opportunity',
]);

export function isActionableObservation(event: InterventionEvent): boolean {
  return Boolean(event.status && ACTIONABLE_STATUSES.has(event.status));
}

export function isJudgeApprovedIntervention(event: InterventionEvent): boolean {
  if (event.intervention_source === 'judge') return true;
  // Compatibility with a sensing process started just before this desktop
  // update: these two event types are emitted only by ProgressDetector._fire.
  return event.type === 'struggle' || event.type === 'discernment_opportunity';
}

/**
 * AI Upskilling is session-based: ambient observer classifications are useful
 * context, but only the Judge may turn them into an interruption. Other modes
 * retain their existing pull-based observer bubbles.
 */
export function shouldOfferInstantSuggestion(
  scenario: string,
  sessionActive: boolean,
  event: InterventionEvent,
): boolean {
  if (!isActionableObservation(event)) return false;
  if (scenario !== 'ai_upskilling') return true;
  return sessionActive && isJudgeApprovedIntervention(event);
}

/**
 * Keep the monorepo's visible observation feedback: lightweight status bubbles
 * such as "Stuck?" and "AI could help" are shown even when the Judge does not
 * approve a full proactive suggestion. Judge gating applies only to generating
 * and pushing the detailed suggestion, not to the avatar's observation state.
 */
export function shouldSurfaceObservation(): boolean {
  return true;
}
