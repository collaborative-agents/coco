/* eslint-disable react/jsx-props-no-spreading */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccountSettings from '../renderer/components/chat/AccountSettings';
import PreferencesSettings from '../renderer/components/chat/PreferencesSettings';

const profile = {
  participantId: 'alex.user',
  userName: 'Alex',
  tutorScenario: 'ai_upskilling',
  aiTools: ['chatgpt'],
  hideAvatar: false,
};

function mockIpc(invoke: jest.Mock) {
  (window as any).electron = { ipcRenderer: { invoke } };
}

it('shows username separately and saves a trimmed preferred name without losing preferences', async () => {
  let latestProfile = profile;
  const invoke = jest.fn(async (channel: string) =>
    channel === 'get-profile' ? latestProfile : { success: true },
  );
  mockIpc(invoke);
  render(<AccountSettings />);
  expect(await screen.findByText('alex.user')).toBeInTheDocument();
  const name = screen.getByLabelText('What should Coco call you?');
  expect(name).toHaveValue('Alex');
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  latestProfile = { ...profile, hideAvatar: true };
  fireEvent.change(name, { target: { value: '  Lex  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('save-profile', {
      ...latestProfile,
      userName: 'Lex',
    }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Name saved for new conversations.',
  );
  expect(name).toHaveValue('Lex');
  fireEvent.change(name, { target: { value: '   ' } });
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
});

it('does not overwrite a profile if the signed-in account changed', async () => {
  const invoke = jest
    .fn()
    .mockResolvedValueOnce(profile)
    .mockResolvedValue({ ...profile, participantId: 'other.user' });
  mockIpc(invoke);
  render(<AccountSettings />);
  await screen.findByText('alex.user');
  fireEvent.change(screen.getByLabelText('What should Coco call you?'), {
    target: { value: 'Lex' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Your account has changed',
  );
  expect(invoke).not.toHaveBeenCalledWith('save-profile', expect.anything());
});

it('allows retrying account loading and never enables editing an unloaded profile', async () => {
  const invoke = jest
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(profile);
  mockIpc(invoke);
  render(<AccountSettings />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not load your account',
  );
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('alex.user')).toBeInTheDocument();
});

it('keeps the name draft and reports a failed save', async () => {
  const invoke = jest.fn(async (channel: string) =>
    channel === 'get-profile'
      ? profile
      : { success: false, error: 'Could not write profile.' },
  );
  mockIpc(invoke);
  render(<AccountSettings />);
  await screen.findByText('alex.user');
  const name = screen.getByLabelText('What should Coco call you?');
  fireEvent.change(name, { target: { value: 'Lex' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not write profile.',
  );
  expect(name).toHaveValue('Lex');
  expect(screen.getByRole('button', { name: 'Save name' })).toBeEnabled();
});

function preferenceProps() {
  return {
    editHideAvatar: false,
    avatarSaving: false,
    avatarSaveError: '',
    updateAvatarVisibility: jest.fn(async () => {}),
    wakeWordEnabled: false,
    wakeWordSaving: false,
    wakeWordCaptureError: '',
    wakeWordStatus: 'disabled' as const,
    wakeWordDetail: '',
    cocoSleeping: false,
    updateWakeWordEnabled: jest.fn(async () => {}),
  };
}

it('offers independent, positively worded switches for voice and desktop avatar', () => {
  const props = preferenceProps();
  const { rerender } = render(<PreferencesSettings {...props} />);
  const avatar = screen.getByRole('switch', { name: 'Desktop avatar' });
  const voice = screen.getByRole('switch', { name: 'Voice activation' });
  expect(avatar).toBeChecked();
  expect(voice).not.toBeChecked();
  expect(screen.getByText(/menu bar icon stays available/)).toBeInTheDocument();
  fireEvent.click(avatar);
  expect(props.updateAvatarVisibility).toHaveBeenCalledWith(true);
  fireEvent.click(voice);
  expect(props.updateWakeWordEnabled).toHaveBeenCalledWith(true);
  rerender(<PreferencesSettings {...props} editHideAvatar />);
  fireEvent.click(avatar);
  expect(props.updateAvatarVisibility).toHaveBeenCalledWith(false);
});

it('disables switches during saving and keeps errors visible', () => {
  render(
    <PreferencesSettings
      {...preferenceProps()}
      avatarSaving
      wakeWordSaving
      wakeWordEnabled
      avatarSaveError="Avatar could not be updated."
      wakeWordCaptureError="Permission denied"
    />,
  );
  expect(screen.getByRole('switch', { name: 'Desktop avatar' })).toBeDisabled();
  expect(
    screen.getByRole('switch', { name: 'Voice activation' }),
  ).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Avatar could not be updated.',
  );
  expect(
    screen.getByText('Microphone unavailable: Permission denied'),
  ).toBeInTheDocument();
});
