import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import SelfEfficacySection from '../renderer/components/training/SelfEfficacySection';

const originalWidth = window.innerWidth;
afterEach(() => {
  window.innerWidth = originalWidth;
});

it('shows all four ratings with one shared legend and submits unchanged answers', () => {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  render(
    <SelfEfficacySection complete={false} busy={false} onSubmit={onSubmit} />,
  );
  expect(screen.getAllByRole('radiogroup')).toHaveLength(4);
  expect(screen.getByText('1 = Strongly disagree')).toBeInTheDocument();
  expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  const submit = screen.getByRole('button', { name: 'Submit self-assessment' });
  expect(submit).toBeDisabled();
  screen.getAllByRole('radiogroup').forEach((group) => {
    fireEvent.click(within(group).getByRole('radio', { name: '4 — Agree' }));
  });
  fireEvent.click(submit);
  expect(onSubmit).toHaveBeenCalledWith({ '1': 4, '2': 4, '3': 4, '4': 4 });
});

it('preserves ratings across compact pages and requires every answer', () => {
  window.innerWidth = 420;
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  render(
    <SelfEfficacySection complete={false} busy={false} onSubmit={onSubmit} />,
  );
  expect(screen.getAllByRole('radiogroup')).toHaveLength(2);
  screen.getAllByRole('radiogroup').forEach((group) => {
    fireEvent.click(
      within(group).getByRole('radio', { name: '5 — Strongly agree' }),
    );
  });
  const submit = screen.getByRole('button', { name: 'Submit self-assessment' });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Next questions' }));
  screen.getAllByRole('radiogroup').forEach((group) => {
    fireEvent.click(
      within(group).getByRole('radio', {
        name: '3 — Neither agree nor disagree',
      }),
    );
  });
  expect(submit).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous questions' }));
  screen
    .getAllByRole('radio', { name: '5 — Strongly agree' })
    .forEach((radio) => expect(radio).toBeChecked());
  fireEvent.click(submit);
  expect(onSubmit).toHaveBeenCalledWith({ '1': 5, '2': 5, '3': 3, '4': 3 });
});

it('disables rating controls during submission', () => {
  render(<SelfEfficacySection complete={false} busy onSubmit={jest.fn()} />);
  screen.getAllByRole('radio').forEach((radio) => expect(radio).toBeDisabled());
  expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
});
