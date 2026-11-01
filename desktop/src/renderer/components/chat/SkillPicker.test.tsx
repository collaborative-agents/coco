import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SkillPicker from './SkillPicker';

jest.mock('./MessageContent', () => ({
  TutorMessage: ({ text }: { text: string }) => <span>{text}</span>,
}));

test('Create skill opens the guided conversation without chapter state or a raw editor', async () => {
  const invoke = jest.fn(async (channel: string) =>
    channel === 'curated-skills-list' ? [] : { sessionId: 'workshop' },
  );
  (window as any).electron = { ipcRenderer: { invoke, on: () => () => {} } };
  render(<SkillPicker disabled={false} onSelect={jest.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Skills' }));
  await screen.findByRole('button', { name: /Import skill/ });
  fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('skill-workshop-start'),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(screen.queryByLabelText('Instructions')).not.toBeInTheDocument();
});

test('existing skills remain selectable', async () => {
  const invoke = jest.fn(async () => [
    {
      id: 'review',
      name: 'review',
      description: 'Review a document',
      markdown: 'Read and summarize.',
      files: [],
    },
  ]);
  (window as any).electron = { ipcRenderer: { invoke, on: () => () => {} } };
  const select = jest.fn();
  render(<SkillPicker disabled={false} onSelect={select} />);
  fireEvent.click(screen.getByRole('button', { name: 'Skills' }));
  fireEvent.click(
    await screen.findByRole('button', { name: /review Review a document/ }),
  );
  expect(select).toHaveBeenCalledWith('review');
});
