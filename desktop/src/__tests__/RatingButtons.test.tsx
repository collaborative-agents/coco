import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import RatingButtons from '../renderer/components/RatingButtons';

describe('RatingButtons', () => {
  it('marks the chosen thumb and lets the other one change the rating', () => {
    const onRate = jest.fn();
    render(<RatingButtons value="down" onRate={onRate} />);

    const helpful = screen.getByRole('button', { name: 'Helpful' });
    const notHelpful = screen.getByRole('button', { name: 'Not helpful' });
    expect(notHelpful).toHaveAttribute('aria-pressed', 'true');
    expect(notHelpful).toHaveClass('is-selected');
    expect(helpful).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(notHelpful);
    expect(onRate).not.toHaveBeenCalled();
    fireEvent.click(helpful);
    expect(onRate).toHaveBeenCalledWith('up');
  });

  it('fills only the selected icon', () => {
    const { container } = render(
      <RatingButtons value="up" onRate={jest.fn()} />,
    );
    const fills = Array.from(container.querySelectorAll('svg')).map((svg) =>
      svg.getAttribute('fill'),
    );
    expect(fills).toEqual(['currentColor', 'none']);
  });
});
