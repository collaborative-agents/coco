import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import LocalModelPicker from '../renderer/components/chat/LocalModelPicker';

it('loads a model saved in setup when the chat window regains focus', async () => {
  let config: any = null;
  const invoke = jest.fn(async (channel: string) =>
    channel === 'get-model-configuration' ? config : null,
  );
  (window as any).electron = { ipcRenderer: { invoke } };
  await act(async () => {
    render(
      <LocalModelPicker
        value=""
        disabled={false}
        onChange={jest.fn()}
        refreshKey={false}
      />,
    );
  });
  expect(
    screen.queryByRole('combobox', { name: 'Chat model' }),
  ).not.toBeInTheDocument();
  config = {
    defaultTutorId: 'inkling',
    tutors: [
      {
        id: 'inkling',
        label: 'Inkling',
        provider: 'tinker',
        model: 'tinker/thinkingmachines/Inkling',
      },
    ],
  };
  fireEvent(window, new Event('focus'));
  expect(
    await screen.findByRole('combobox', { name: 'Chat model' }),
  ).toHaveValue('inkling');
  expect(screen.getByRole('option', { name: 'Inkling' })).toBeInTheDocument();
});
