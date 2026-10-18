import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import OnboardingView from '../renderer/components/OnboardingView';

function setup(
  query = 'routerManaged=1',
  overrides: Record<string, unknown> = {},
) {
  window.history.pushState({}, '', `/?view=onboarding&${query}`);
  const responses: Record<string, unknown> = {
    'get-llm-router-status': { configured: query.includes('routerManaged=1') },
    'get-profile': null,
    'get-system-permissions': { missing: [] },
    'get-wake-word-settings': { enabled: false },
    'set-wake-word-settings': { success: true },
    'save-model-configuration': { success: true },
    ...overrides,
  };
  const invoke = jest.fn(async (channel: string) => responses[channel] ?? null);
  const sendMessage = jest.fn();
  (window as any).electron = { ipcRenderer: { invoke, sendMessage } };
  return { invoke, sendMessage, responses };
}
async function next() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  });
}
async function enterName() {
  await next();
  fireEvent.change(screen.getByLabelText('Your name or preferred nickname'), {
    target: { value: ' Ada ' },
  });
  await next();
}

describe('onboarding window', () => {
  beforeEach(() => jest.spyOn(window, 'close').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('skips model selection when the packaged Router manages credentials', async () => {
    setup();
    await act(async () => {
      render(<OnboardingView />);
    });
    expect(
      screen.getByRole('heading', {
        name: 'Meet Coco, your proactive co-assistant',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 / 5')).toBeInTheDocument();
    expect(
      screen.queryByText('Connect Coco to your models'),
    ).not.toBeInTheDocument();
  });

  it('can be hidden temporarily from model-only setup', async () => {
    const { sendMessage } = setup('modelsOnly=1');
    await act(async () => {
      render(<OnboardingView />);
    });
    expect(screen.getByText('Model setup')).toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Close setup for now' }),
    );
    expect(sendMessage).toHaveBeenCalledWith('hide-onboarding');
  });

  it('requires only a name and never reads or overwrites memory', async () => {
    const { invoke } = setup();
    await act(async () => {
      render(<OnboardingView />);
    });
    await next();
    await next();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the name');
    expect(
      screen.queryByText(/Example memories|Memory \(optional\)/),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your name or preferred nickname'), {
      target: { value: 'Ada' },
    });
    await next();
    expect(
      screen.getByRole('heading', { name: 'Permissions & privacy' }),
    ).toBeInTheDocument();
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === 'get-memory' || channel === 'save-memory',
      ),
    ).toBe(false);
  });

  it('waits for permissions and refreshes when returning from system settings', async () => {
    const { invoke, responses } = setup('routerManaged=1', {
      'get-system-permissions': { missing: [{ target: 'screen-recording' }] },
      'open-system-permissions': { success: true },
    });
    await act(async () => {
      render(<OnboardingView />);
    });
    await enterName();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByText('Privacy & your data')).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    });
    expect(invoke).toHaveBeenCalledWith(
      'open-system-permissions',
      'screen-recording',
    );
    responses['get-system-permissions'] = { missing: [] };
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await next();
    expect(
      screen.getByRole('switch', { name: 'Listen for Coco' }),
    ).not.toBeChecked();
    expect(screen.queryByText('Privacy & your data')).not.toBeInTheDocument();
  });

  it('keeps permissions blocked if their status cannot be loaded', async () => {
    setup('routerManaged=1', { 'get-system-permissions': null });
    await act(async () => {
      render(<OnboardingView />);
    });
    await enterName();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not check permissions',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('handles microphone denial without enabling voice and allows continuing', async () => {
    const { invoke } = setup('routerManaged=1', {
      'set-wake-word-settings': {
        success: false,
        error: 'Microphone access is required.',
      },
    });
    await act(async () => {
      render(<OnboardingView />);
    });
    await enterName();
    await next();
    await act(async () => {
      fireEvent.click(screen.getByRole('switch'));
    });
    expect(invoke).toHaveBeenCalledWith('set-wake-word-settings', {
      enabled: true,
    });
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Microphone access is required.',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it.each([false, true])(
    'persists avatar hidden=%s with the existing profile payload',
    async (hidden) => {
      const { invoke, sendMessage } = setup();
      await act(async () => {
        render(<OnboardingView />);
      });
      await enterName();
      await next();
      await act(async () => {
        fireEvent.click(screen.getByRole('switch'));
      });
      expect(screen.getByRole('switch')).toBeChecked();
      await next();
      expect(screen.getByText('5 / 5')).toBeInTheDocument();
      expect(screen.queryByText('Your AI toolkit')).not.toBeInTheDocument();
      expect(
        screen.queryByText('How should Coco support you?'),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('radio', { name: /Avatar \+ menu bar/ }),
      ).toBeChecked();
      expect(
        screen.getByText(/menu-bar icon is always available/),
      ).toBeVisible();
      if (hidden)
        fireEvent.click(screen.getByRole('radio', { name: /Menu bar only/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      });
      expect(
        screen.getByRole('heading', { name: 'Hey Coco' }),
      ).toBeInTheDocument();
      expect(screen.getByText('4 / 5')).toBeInTheDocument();
      await next();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Start Coco' }));
      });
      expect(sendMessage).toHaveBeenCalledWith(
        'onboarding-complete',
        expect.objectContaining({
          onboardingComplete: true,
          userName: 'Ada',
          hideAvatar: hidden,
          tutorScenario: 'ai_upskilling',
          aiTools: [],
          customSystemPrompt: '',
        }),
      );
      expect(invoke).not.toHaveBeenCalledWith('save-memory', expect.anything());
      expect(window.close).toHaveBeenCalled();
    },
  );

  it('preserves model-only saving through the existing IPC contract', async () => {
    const { invoke, sendMessage } = setup('modelsOnly=1');
    await act(async () => {
      render(<OnboardingView />);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save & start Coco' }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('model-configuration-complete'),
    );
    expect(invoke).toHaveBeenCalledWith(
      'save-model-configuration',
      expect.objectContaining({
        sensing: expect.any(Object),
        tutors: expect.any(Array),
        defaultTutorId: 'tutor-1',
        credentials: {},
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      'onboarding-complete',
      expect.anything(),
    );
  });
});
