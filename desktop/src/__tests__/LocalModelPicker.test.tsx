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

it('offers only the active model’s thinking amounts from the composer', async () => {
  const onThinkingChange = jest.fn();
  const invoke = jest.fn(async (channel) =>
    channel === 'get-model-configuration'
      ? {
          defaultTutorId: 'reasoner',
          tutors: [
            {
              id: 'reasoner',
              label: 'Reasoner',
              provider: 'pi',
              model: 'pi/openai/reasoner',
            },
          ],
        }
      : {
          models: [
            {
              provider: 'openai',
              id: 'reasoner',
              thinkingLevels: ['low', 'medium', 'high'],
              defaultThinking: 'medium',
            },
          ],
        },
  );
  (window as any).electron = { ipcRenderer: { invoke } };
  render(
    <LocalModelPicker
      value="reasoner"
      disabled={false}
      onChange={jest.fn()}
      refreshKey={false}
      thinking="default"
      onThinkingChange={onThinkingChange}
    />,
  );
  const trigger = await screen.findByRole('button', {
    name: 'Reasoner, thinking: Medium',
  });
  fireEvent.click(trigger);
  const slider = screen.getByRole('slider', { name: 'Thinking amount' });
  expect(slider).toHaveAttribute('max', '2');
  expect(slider).toHaveAttribute('aria-valuetext', 'Medium');
  fireEvent.change(slider, { target: { value: '2' } });
  expect(onThinkingChange).toHaveBeenCalledWith('high');
  fireEvent.keyDown(slider, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(invoke).not.toHaveBeenCalledWith(
    'save-model-configuration',
    expect.anything(),
  );
});

it('offers Qwen on/off and supports keyboard dismissal', async () => {
  (window as any).electron = {
    ipcRenderer: {
      invoke: jest.fn(async (channel) =>
        channel === 'get-model-configuration'
          ? {
              defaultTutorId: 'qwen',
              tutors: [
                {
                  id: 'qwen',
                  label: 'Qwen',
                  provider: 'hosted_vllm',
                  model: 'hosted_vllm/Qwen/Qwen3.8-27B',
                },
              ],
            }
          : null,
      ),
    },
  };
  const view = render(
    <LocalModelPicker
      value="qwen"
      disabled={false}
      onChange={jest.fn()}
      refreshKey={false}
      thinking="on"
      onThinkingChange={jest.fn()}
    />,
  );
  const trigger = await screen.findByRole('button', { name: 'Qwen, thinking: On' });
  fireEvent.click(trigger);
  expect(screen.getByRole('slider')).toHaveAttribute('max', '1');
  expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'On');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  view.rerender(
    <LocalModelPicker
      value="qwen"
      disabled
      onChange={jest.fn()}
      refreshKey={false}
      thinking="on"
      onThinkingChange={jest.fn()}
    />,
  );
  expect(trigger).toBeDisabled();
});
