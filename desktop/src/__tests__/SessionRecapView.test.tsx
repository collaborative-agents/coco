import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SessionRecapView from '../renderer/components/SessionRecapView';

describe('SessionRecapView completion tracking', () => {
  const sendMessage = jest.fn();
  const listeners = new Map<string, (...args: any[]) => void>();

  beforeEach(() => {
    sendMessage.mockClear();
    listeners.clear();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        ipcRenderer: {
          sendMessage,
          on: (channel: string, callback: (...args: any[]) => void) => {
            listeners.set(channel, callback);
            return () => listeners.delete(channel);
          },
        },
      },
    });
    jest.spyOn(window, 'close').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('marks closing without an answer as a skipped quiz', () => {
    render(<SessionRecapView />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip recap' }));

    expect(sendMessage).toHaveBeenCalledWith('session-recap-done', {
      quizSkipped: true,
      quizAnswered: false,
    });
  });

  it('records an answered quiz as completed rather than skipped', () => {
    render(<SessionRecapView />);
    act(() => {
      listeners.get('session-recap-data')?.({
        data: {
          summary_title: 'You practiced giving AI clear context.',
          bullets: ['You described the task and constraints.'],
          quiz: {
            question: 'What should you do next?',
            choices: ['Check the output', 'Ignore the output'],
            correct_index: 0,
            explanation: 'Reviewing the result catches errors.',
          },
        },
        error: false,
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /Check the output/ }));
    fireEvent.click(screen.getByRole('button', { name: 'End session' }));

    expect(sendMessage).toHaveBeenCalledWith('session-recap-done', {
      quizSkipped: false,
      quizAnswered: true,
      quizCorrect: true,
      selectedIndex: 0,
    });
  });
});
