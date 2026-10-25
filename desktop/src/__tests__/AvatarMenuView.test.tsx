import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import AvatarMenuView from '../renderer/components/AvatarMenuView';

function setup(invokeResponses: Record<string, unknown> = {}) {
  const sendMessage = jest.fn();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const invoke = jest.fn(async (channel: string) =>
    channel in invokeResponses ? invokeResponses[channel] : { sleeping: false },
  );
  (window as any).electron = {
    ipcRenderer: {
      on: jest.fn((channel: string, callback: (...args: unknown[]) => void) => {
        listeners.set(channel, callback);
        return () => listeners.delete(channel);
      }),
      sendMessage,
      invoke,
    },
  };
  render(<AvatarMenuView />);
  const open = (below = false) =>
    act(() => listeners.get('avatar-menu-open')?.({ below }));
  return { sendMessage, invoke, listeners, open };
}

describe('AvatarMenuView', () => {
  it('stays hidden until main opens it', () => {
    const { open } = setup();
    expect(screen.getByRole('menu', { hidden: true })).toHaveClass('is-closed');
    open();
    expect(screen.getByRole('menu', { name: 'Coco actions' })).not.toHaveClass(
      'is-closed',
    );
  });

  it('reports its size and, once painted, lets main reveal the window', async () => {
    const { sendMessage, open } = setup();
    expect(sendMessage).toHaveBeenCalledWith(
      'avatar-menu-size',
      expect.objectContaining({ width: expect.any(Number) }),
    );
    open(true);
    expect(screen.getByRole('menu', { name: 'Coco actions' })).toHaveClass(
      'is-below',
    );
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('avatar-menu-painted'),
    );
  });

  it('offers consistent navigation and Quit, without History', () => {
    const { sendMessage, open } = setup();
    open();
    expect(
      screen.getAllByRole('menuitem').map((item) => item.textContent),
    ).toEqual(['Open Chat', 'Settings', 'Hide', 'Sleep', 'Quit']);
    expect(
      screen.queryByRole('menuitem', { name: /History/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Training' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Chat' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sleep' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quit' }));
    expect(
      sendMessage.mock.calls
        .filter(([channel]) => channel === 'avatar-menu-action')
        .map(([, action]) => action),
    ).toEqual([
      'open-main-window',
        'open-chat-settings',
      'toggle-sleep',
      'quit',
    ]);
  });

  it('offers Wake Coco while Coco is asleep', async () => {
    const { open } = setup({ 'get-coco-sleep-mode': { sleeping: true } });
    open();
    expect(
      await screen.findByRole('menuitem', { name: 'Wake Coco' }),
    ).toBeInTheDocument();
  });

  it('hides the avatar without sleeping or quitting, then closes', async () => {
    const { sendMessage, invoke, open } = setup({
      'update-avatar-visibility': { success: true },
    });
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('close-avatar-menu'),
    );
    expect(invoke).toHaveBeenCalledWith('update-avatar-visibility', {
      hideAvatar: true,
    });
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'set-coco-sleep-mode'),
    ).toBe(false);
    expect(sendMessage).not.toHaveBeenCalledWith(
      'avatar-menu-action',
      expect.anything(),
    );
  });

  it('stays open with an error when hiding fails', async () => {
    const { sendMessage, open } = setup({
      'update-avatar-visibility': { success: false },
    });
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not hide Coco',
    );
    expect(sendMessage).not.toHaveBeenCalledWith('close-avatar-menu');
  });

  it('closes when the transparent area around the menu is clicked', () => {
    const { sendMessage, open } = setup();
    open();
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(sendMessage).not.toHaveBeenCalledWith('close-avatar-menu');
    fireEvent.pointerDown(document.querySelector('.avatar-menu-view')!);
    expect(sendMessage).toHaveBeenCalledWith('close-avatar-menu');
  });

  it('closes on Escape', () => {
    const { sendMessage, open } = setup();
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(sendMessage).toHaveBeenCalledWith('close-avatar-menu');
  });
});
