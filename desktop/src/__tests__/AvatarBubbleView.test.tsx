import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import AvatarBubbleView from '../renderer/components/AvatarBubbleView';

const setup = () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sendMessage = jest.fn();
  (window as any).electron = {
    ipcRenderer: {
      on: (channel: string, callback: (...args: unknown[]) => void) => {
        listeners.set(channel, callback);
        return () => listeners.delete(channel);
      },
      sendMessage,
      invoke: jest.fn(),
    },
  };
  const { container } = render(<AvatarBubbleView />);
  const showBubble = (bubble: unknown, maxHeight = 600) =>
    act(() => listeners.get('avatar-bubble-state')?.({ bubble, maxHeight }));
  return { listeners, sendMessage, container, showBubble };
};

const stuckBubble = {
  status: 'stuck',
  phrase: 'Been on this for a bit',
  fadingOut: false,
  showHelpButton: true,
  observationId: 'obs-1',
};

describe('AvatarBubbleView', () => {
  it('draws the bubble main sends and reports its size', () => {
    const { sendMessage, showBubble } = setup();
    showBubble(stuckBubble);
    expect(screen.getByText('Been on this for a bit')).toBeInTheDocument();
    expect(sendMessage).toHaveBeenCalledWith(
      'avatar-bubble-size',
      expect.objectContaining({ width: expect.any(Number) }),
    );
  });

  it('sends clicks to the avatar renderer', () => {
    const { sendMessage, showBubble } = setup();
    showBubble(stuckBubble);
    fireEvent.click(screen.getByRole('button', { name: 'Help me with this' }));
    expect(sendMessage).toHaveBeenCalledWith('avatar-bubble-event', 'help');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(sendMessage).toHaveBeenCalledWith('avatar-bubble-event', 'dismiss');
  });

  it('catches the mouse only while it is over the card', () => {
    const { sendMessage, container, showBubble } = setup();
    showBubble(stuckBubble);
    const card = container.querySelector('.observation-bubble')!;
    fireEvent.mouseEnter(card);
    expect(sendMessage).toHaveBeenCalledWith('avatar-bubble-pointer', {
      inside: true,
    });
    expect(sendMessage).toHaveBeenCalledWith('avatar-bubble-event', 'enter');
    fireEvent.mouseLeave(card);
    expect(sendMessage).toHaveBeenCalledWith('avatar-bubble-pointer', {
      inside: false,
    });
    expect(sendMessage).toHaveBeenCalledWith('avatar-bubble-event', 'leave');
  });

  it("flips the tail when main places the bubble on Coco's right", () => {
    const { listeners, container, showBubble } = setup();
    showBubble(stuckBubble);
    expect(container.querySelector('.avatar-bubble-view')).toHaveClass(
      'is-left',
    );
    act(() => listeners.get('avatar-bubble-placement')?.({ side: 'right' }));
    expect(container.querySelector('.avatar-bubble-view')).toHaveClass(
      'is-right',
    );
  });

  it('limits a tall suggestion to the height main allows', () => {
    const { container, showBubble } = setup();
    showBubble(stuckBubble, 480);
    expect(
      (
        container.querySelector('.avatar-bubble-view') as HTMLElement
      ).style.getPropertyValue('--bubble-max-height'),
    ).toBe('480px');
  });

  it('clears the bubble when main sends none', () => {
    const { sendMessage, showBubble } = setup();
    showBubble(stuckBubble);
    showBubble(null);
    expect(
      screen.queryByText('Been on this for a bit'),
    ).not.toBeInTheDocument();
    expect(sendMessage).toHaveBeenLastCalledWith('avatar-bubble-pointer', {
      inside: false,
    });
  });
});
