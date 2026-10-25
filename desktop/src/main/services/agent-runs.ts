import PiHarness from './pi-harness';

/** One runtime per conversation; request IDs scope stop and answer actions. */
export default class AgentRuns {
  private readonly harnesses = new Map<string, PiHarness>();
  readonly requests = new Map<
    string,
    { sessionId: string; stopped: boolean; legacy: boolean }
  >();

  constructor(private readonly createHarness = () => new PiHarness()) {}

  begin(sessionId: string, requestId: string, legacy = false) {
    if (this.requests.has(requestId) || this.has(sessionId))
      throw new Error(
        'This conversation is already working. Stop its run first.',
      );
    if (
      [...this.requests.values()].some((request) => request.legacy) ||
      (legacy && this.requests.size)
    )
      throw new Error(
        'Wait for the current runs before starting a practice suggestion.',
      );
    this.requests.set(requestId, { sessionId, stopped: false, legacy });
  }

  has(sessionId: string | null) {
    return [...this.requests.values()].some(
      (request) => request.sessionId === sessionId,
    );
  }

  get busy() {
    return this.requests.size > 0;
  }

  get legacyBusy() {
    return [...this.requests.values()].some((request) => request.legacy);
  }

  get(sessionId: string) {
    let harness = this.harnesses.get(sessionId);
    if (!harness) {
      harness = this.createHarness();
      this.harnesses.set(sessionId, harness);
    }
    return harness;
  }

  finish(requestId: string) {
    this.requests.delete(requestId);
  }

  async abort(requestId?: string) {
    const selected = [...this.requests].filter(
      ([id]) => !requestId || id === requestId,
    );
    await Promise.all(
      selected.map(async ([id, request]) => {
        request.stopped = true;
        await this.harnesses.get(request.sessionId)?.abort(id);
      }),
    );
  }

  answer(requestId: string, toolCallId: string, response: unknown) {
    const request = this.requests.get(requestId);
    if (!request || request.stopped)
      throw new Error('This run is no longer active.');
    this.get(request.sessionId).answerQuestion(toolCallId, response);
  }

  async dispose() {
    await this.abort();
    await Promise.all(
      [...this.harnesses.values()].map((harness) => harness.dispose()),
    );
    this.harnesses.clear();
  }
}
