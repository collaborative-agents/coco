import { InteractionTracker } from './interaction-tracker';

describe('InteractionTracker', () => {
  let clock: number;
  let reported: string[];
  let tracker: InteractionTracker;

  beforeEach(() => {
    clock = 1_000;
    reported = [];
    tracker = new InteractionTracker(
      (source) => reported.push(source),
      () => clock,
    );
  });

  it('reports the user message and the tutor reply for each turn', async () => {
    await tracker.trackTurn(async () => {
      clock += 5_000;
    });
    expect(reported).toEqual(['user_message', 'tutor_reply']);
  });

  it('reports the reply even when the turn fails', async () => {
    await expect(
      tracker.trackTurn(async () => {
        throw new Error('tutor down');
      }),
    ).rejects.toThrow('tutor down');
    expect(reported).toEqual(['user_message', 'tutor_reply']);
  });

  it('treats the conversation as moved on while a reply is pending', async () => {
    const eventReceivedAt = clock + 1;
    let pendingCheck: boolean | undefined;
    await tracker.trackTurn(async () => {
      clock += 10;
      pendingCheck = tracker.movedOnSince(eventReceivedAt);
    });
    expect(pendingCheck).toBe(true);
  });

  it('drops suggestions whose event arrived before the last interaction', () => {
    const eventReceivedAt = clock;
    clock += 2_000;
    tracker.note('suggestion_shown');
    expect(tracker.movedOnSince(eventReceivedAt)).toBe(true);
  });

  it('keeps suggestions whose event arrived after the last interaction', async () => {
    await tracker.trackTurn(async () => {});
    clock += 30_000;
    expect(tracker.movedOnSince(clock)).toBe(false);
  });
});
