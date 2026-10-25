import AgentProgressReminder from '../main/services/agent-progress-reminder';

describe('agent working reminders', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('samples the latest activity every 30 seconds and stops at completion', () => {
    const publish = jest.fn();
    const reminder = new AgentProgressReminder(publish);
    reminder.update({
      type: 'agent_activity',
      activity: [{ kind: 'message', text: 'Checking the results.' }],
    });
    jest.advanceTimersByTime(29_999);
    expect(publish).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(publish).toHaveBeenLastCalledWith('Checking the results.');
    reminder.update({
      type: 'agent_activity',
      activity: [
        {
          kind: 'tool',
          call: {
            id: 'tool',
            name: 'read',
            status: 'running',
            arguments: {},
          },
        },
      ],
    });
    jest.advanceTimersByTime(30_000);
    expect(publish).toHaveBeenLastCalledWith('Working with read…');
    reminder.update({ type: 'text_delta', text: 'Comparing ' });
    reminder.update({ type: 'text_delta', text: 'the two results.' });
    jest.advanceTimersByTime(30_000);
    expect(publish).toHaveBeenLastCalledWith('Comparing the two results.');
    reminder.update({ type: 'done' });
    jest.advanceTimersByTime(60_000);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('has a truthful fallback when quiet and cancels on disposal or error', () => {
    const publish = jest.fn();
    const reminder = new AgentProgressReminder(publish);
    jest.advanceTimersByTime(30_000);
    expect(publish).toHaveBeenCalledWith('Still working on your request…');
    reminder.dispose();
    const failed = new AgentProgressReminder(publish);
    failed.update({ type: 'error' });
    jest.advanceTimersByTime(60_000);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
