import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SkillWorkshopBanner from './SkillWorkshopBanner';

const session = {
  sessionId: 'workshop',
  draft: {},
  version: 2,
  trials: [{ draftVersion: 1 }],
  savedSkillId: null,
};
function setup(value: any) {
  const invoke = jest.fn(async (channel: string) =>
    channel === 'skill-workshop-save'
      ? { ...value, savedSkillId: 'saved' }
      : value,
  );
  (window as any).electron = { ipcRenderer: { invoke, on: () => () => {} } };
  return invoke;
}

test('an older trial does not enable saving the current draft', async () => {
  setup(session);
  render(<SkillWorkshopBanner sessionId="workshop" busy={false} />);
  await screen.findByRole('complementary', { name: 'Skill creation progress' });
  expect(
    screen.queryByRole('button', { name: 'Save skill' }),
  ).not.toBeInTheDocument();
});

test('saving requires an explicit click and remains disabled during a run', async () => {
  const invoke = setup({ ...session, trials: [{ draftVersion: 2 }] });
  const view = render(<SkillWorkshopBanner sessionId="workshop" busy />);
  expect(
    await screen.findByRole('button', { name: 'Save skill' }),
  ).toBeDisabled();
  expect(invoke).not.toHaveBeenCalledWith('skill-workshop-save', 'workshop');
  view.rerender(<SkillWorkshopBanner sessionId="workshop" busy={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save skill' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('skill-workshop-save', 'workshop'),
  );
  expect(await screen.findByText(/Your skill is saved/)).toBeInTheDocument();
});
