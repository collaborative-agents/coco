import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import AvatarHistoryView from '../renderer/components/AvatarHistoryView';

const now = Math.floor(Date.now() / 1000);
const history = [
  {
    ts: now - 120,
    status: 'stuck',
    observation: 'Older observation',
    observation_id: 'obs-old',
    proactive_support: { engaged: false, available: true },
  },
  {
    ts: now - 60,
    status: 'progress',
    observation: 'Newer observation',
    observation_id: 'obs-new',
  },
];

const setup = (rows: unknown[] = history) => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sendMessage = jest.fn();
  const invoke = jest.fn(async (channel: string) =>
    channel === 'get-activity-history' ? rows : null,
  );
  (window as any).electron = {
    ipcRenderer: {
      on: (channel: string, callback: (...args: unknown[]) => void) => {
        listeners.set(channel, callback);
        return () => listeners.delete(channel);
      },
      sendMessage,
      invoke,
    },
  };
  render(<AvatarHistoryView />);
  const openPanel = () =>
    act(async () => {
      listeners.get('avatar-history-open')?.();
    });
  return { listeners, sendMessage, invoke, openPanel };
};

describe('AvatarHistoryView', () => {
  it('reads the persisted history when opened, newest first', async () => {
    const { invoke, sendMessage, openPanel } = setup();
    expect(screen.queryByText('Activity')).not.toBeInTheDocument();

    await openPanel();
    expect(invoke).toHaveBeenCalledWith('get-activity-history');
    const texts = screen
      .getAllByText(/observation$/)
      .map((element) => element.textContent);
    expect(texts).toEqual(['Newer observation', 'Older observation']);
    expect(sendMessage).toHaveBeenCalledWith(
      'avatar-history-size',
      expect.objectContaining({ width: expect.any(Number) }),
    );
  });

  it('asks main to close it, and hides when main closes it', async () => {
    const { listeners, sendMessage, openPanel } = setup();
    await openPanel();
    fireEvent.click(screen.getByTitle('Close'));
    expect(sendMessage).toHaveBeenCalledWith('avatar-history-close');

    act(() => listeners.get('avatar-history-closed')?.());
    expect(screen.queryByText('Activity')).not.toBeInTheDocument();
  });

  it('rereads the history shortly after it changes', async () => {
    jest.useFakeTimers();
    const { listeners, invoke, openPanel } = setup();
    await openPanel();
    invoke.mockClear();

    act(() => {
      listeners.get('activity-history-changed')?.();
      listeners.get('activity-history-changed')?.();
    });
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('get-activity-history');
    jest.useRealTimers();
  });

  it('records a rating on past support', async () => {
    const { sendMessage, openPanel } = setup();
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Good suggestion' }));
    expect(sendMessage).toHaveBeenCalledWith(
      'activity-support-rated',
      expect.objectContaining({ observationId: 'obs-old', rating: 'up' }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'training-feedback',
      expect.objectContaining({ kind: 'thumbs_up', surface: 'history' }),
    );
  });

  it('points its tail at Coco where main placed it', async () => {
    const { listeners, openPanel } = setup();
    await openPanel();
    act(() =>
      listeners.get('avatar-history-placement')?.({
        side: 'right',
        tailY: 120,
      }),
    );
    const tail = document.querySelector('.avatar-history-tail') as HTMLElement;
    expect(tail).toHaveClass('is-right');
    expect(tail.style.top).toBe('114px');
  });

  it('catches the mouse only over the panel', async () => {
    const { sendMessage, openPanel } = setup();
    await openPanel();
    const card = document.querySelector('.avatar-history-card')!;
    fireEvent.mouseEnter(card);
    expect(sendMessage).toHaveBeenCalledWith('avatar-history-pointer', {
      inside: true,
    });
    fireEvent.mouseLeave(card);
    expect(sendMessage).toHaveBeenCalledWith('avatar-history-pointer', {
      inside: false,
    });
  });
});
