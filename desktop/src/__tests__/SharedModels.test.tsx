import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LocalModelSettings from '../renderer/components/chat/LocalModelSettings';

it('selects connected Pi models for sensing and suggestions and saves through the shared configuration', async () => {
  const invoke = jest.fn(async (channel, action) => {
    if (channel === 'pi-provider')
      return {
        connection: { mode: 'coco' },
        flow: null,
        providers: [{ id: 'test', name: 'Test', connected: true }],
        models: [
          {
            provider: 'test',
            id: 'vision',
            name: 'Vision',
            input: ['text', 'image'],
          },
          { provider: 'test', id: 'text', name: 'Text only', input: ['text'] },
        ],
      };
    if (channel === 'get-model-configuration')
      return {
        sensing: {
          id: 'sensing',
          label: 'Sensing',
          provider: 'pi',
          model: 'pi/test/vision',
        },
        tutors: [
          {
            id: 'chat',
            label: 'Chat',
            provider: 'pi',
            model: 'pi/test/vision',
          },
          { id: 'fast', label: 'Fast', provider: 'pi', model: 'pi/test/text' },
        ],
        defaultTutorId: 'chat',
      };
    if (channel === 'save-model-configuration')
      return { success: true, config: action };
    return null;
  });
  (window as any).electron = { ipcRenderer: { invoke } };
  const view = render(<LocalModelSettings />);
  await waitFor(() =>
    expect(screen.getByLabelText('Sensing Pi model')).toHaveValue(
      'pi/test/vision',
    ),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('heading', { name: 'Connected providers' }),
    ).toBeInTheDocument(),
  );
  const sensing = screen.getByLabelText(
    'Sensing Pi model',
  ) as HTMLSelectElement;
  expect(
    [...sensing.options].some((option) => option.value === 'pi/test/text'),
  ).toBe(false);
  fireEvent.change(screen.getByLabelText('Instant suggestion model'), {
    target: { value: 'fast' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save model settings' }));
  await screen.findByText('Saved');
  expect(invoke).toHaveBeenCalledWith(
    'save-model-configuration',
    expect.objectContaining({
      sensing: expect.objectContaining({
        provider: 'pi',
        model: 'pi/test/vision',
      }),
      defaultTutorId: 'chat',
      instantSuggestionModelId: 'fast',
      credentials: {},
    }),
  );
  expect(screen.queryByText('Use native Pi')).not.toBeInTheDocument();
  view.unmount();
});
