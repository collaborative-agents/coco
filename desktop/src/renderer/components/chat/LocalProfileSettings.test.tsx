import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LocalProfileSettings from './LocalProfileSettings';

function setup(
  profile = {
    tutorScenario: 'everyday_support',
    customSystemPrompt: '',
    hideAvatar: false,
  },
) {
  const invoke = jest.fn(async (channel: string) =>
    channel === 'get-profile' ? profile : { success: true },
  );
  (window as any).electron = { ipcRenderer: { invoke } };
  render(<LocalProfileSettings onSaved={jest.fn()} />);
  return invoke;
}

test('Custom shows the editor and saves its prompt, while switching modes preserves the draft', async () => {
  const invoke = setup();
  const mode = screen.getByRole('combobox', { name: 'Mode' });
  await waitFor(() => expect(mode).toBeEnabled());
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.change(mode, { target: { value: 'custom' } });
  expect(
    screen.getByRole('button', { name: 'Save preferences' }),
  ).toBeDisabled();
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Observer agent prompt' }),
    {
      target: {
        value: 'Watch for spreadsheet errors.\nReport the cell and issue.',
      },
    },
  );
  fireEvent.change(mode, { target: { value: 'everyday_support' } });
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.change(mode, { target: { value: 'custom' } });
  expect(screen.getByRole('textbox')).toHaveValue(
    'Watch for spreadsheet errors.\nReport the cell and issue.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('update-settings', {
      scenario: 'custom',
      hideAvatar: false,
      customObserverPrompt:
        'Watch for spreadsheet errors.\nReport the cell and issue.',
    }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent('Saved');
});

test('loads an existing custom prompt from the profile', async () => {
  setup({
    tutorScenario: 'custom',
    customSystemPrompt: 'Existing observer instructions',
    hideAvatar: false,
  });
  expect(
    await screen.findByRole('textbox', { name: 'Observer agent prompt' }),
  ).toHaveValue('Existing observer instructions');
});
