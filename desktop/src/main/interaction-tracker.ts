/**
 * Tracks conversation activity so proactive suggestions never land on top of
 * a chat turn.
 *
 * An interaction is a user chat message, a finished tutor reply, or a shown
 * suggestion. Each one is reported to the sensing Judge (which then waits a
 * full struggle interval before its next check) and remembered here, so a
 * suggestion whose Judge event arrived before the conversation moved on can be
 * dropped instead of shown.
 */
export type InteractionSource =
  | 'user_message'
  | 'tutor_reply'
  | 'suggestion_shown';

export class InteractionTracker {
  private turnsInFlight = 0;

  private lastInteractionAt = 0;

  private readonly report: (source: InteractionSource) => void;

  private readonly now: () => number;

  constructor(
    report: (source: InteractionSource) => void,
    now: () => number = Date.now,
  ) {
    this.report = report;
    this.now = now;
  }

  note(source: InteractionSource): void {
    this.lastInteractionAt = this.now();
    this.report(source);
  }

  /**
   * Run one tutor turn. Sending the message and finishing the reply both
   * count as interactions, and the turn is "in flight" in between.
   */
  async trackTurn<T>(turn: () => Promise<T>): Promise<T> {
    this.turnsInFlight += 1;
    this.note('user_message');
    try {
      return await turn();
    } finally {
      this.turnsInFlight -= 1;
      this.note('tutor_reply');
    }
  }

  /** True if a tutor reply is on its way or anyone interacted after `since`. */
  movedOnSince(since: number): boolean {
    return this.turnsInFlight > 0 || this.lastInteractionAt > since;
  }
}
