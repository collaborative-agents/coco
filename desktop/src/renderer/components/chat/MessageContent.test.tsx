import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TutorMessage } from './MessageContent';

const guidance =
  '<guidance>Check **study populations** before using these papers.\n\n1. Match the learners.\n2. Check the evidence.\n\nWhich paper fits your course?</guidance><four_d_dimension>discernment</four_d_dimension><teaching_depth>introduce</teaching_depth>';

test('renders coaching as formatted prose and a quiet skill label', () => {
  const { container } = render(<TutorMessage text={guidance} />);
  expect(container.querySelector('strong')).toHaveTextContent(
    'study populations',
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('Which paper fits your course?')).toBeInTheDocument();
  expect(screen.getByLabelText('AI skill: Discernment')).toBeInTheDocument();
  expect(container).not.toHaveTextContent('teaching_depth');
  expect(container).not.toHaveTextContent('introduce');
  expect(container).not.toHaveTextContent('<guidance>');
});

test('keeps prompt line breaks and provides copy confirmation', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  const prompt =
    'Compare the papers.\nUse these criteria:\n- Population\n- Evidence';
  render(
    <TutorMessage
      text={`${guidance}<example_prompt>${prompt}</example_prompt>`}
    />,
  );
  expect(
    screen
      .getByRole('region', { name: 'Suggested prompt' })
      .querySelector('.tutor-prompt-text')?.textContent,
  ).toBe(prompt);
  fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Copied ✓' }),
    ).toBeInTheDocument(),
  );
  expect(writeText).toHaveBeenCalledWith(prompt);
});

test('reports clipboard failure without claiming the prompt was copied', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: jest.fn().mockRejectedValue(new Error('Denied')) },
  });
  render(
    <TutorMessage text="<guidance>Try it.</guidance><example_prompt>Compare.</example_prompt>" />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy');
  expect(
    screen.getByRole('button', { name: 'Copy prompt' }),
  ).toBeInTheDocument();
});

test('renders plain replies without empty cards or coaching labels', () => {
  render(<TutorMessage text="A normal **reply**." />);
  expect(screen.queryByText('AI skill')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Suggested prompt' })).toBeNull();
});

test('keeps visualizations isolated in a titled sandbox', () => {
  render(
    <TutorMessage text="<guidance>A chart.</guidance><html_code><h1>Chart</h1></html_code>" />,
  );
  expect(screen.getByTitle('Coco visualization')).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  );
});

test('renders an existing mixed response without dropping the answer or showing XML', () => {
  const { container } = render(
    <TutorMessage
      text={`## Relevant papers\n\nHere is the research summary.\n\n${guidance}`}
    />,
  );
  expect(
    screen.getByRole('heading', { name: 'Relevant papers' }),
  ).toBeInTheDocument();
  expect(screen.getByText('Here is the research summary.')).toBeInTheDocument();
  expect(screen.getByText('Which paper fits your course?')).toBeInTheDocument();
  expect(screen.getByLabelText('AI skill: Discernment')).toBeInTheDocument();
  expect(container).not.toHaveTextContent('<guidance>');
  expect(container).not.toHaveTextContent('teaching_depth');
});

test('places literacy coaching in a separate card after the answer without duplication', () => {
  const { container } = render(
    <TutorMessage text={`Here is the research summary.\n\n${guidance}`} />,
  );
  const main = container.querySelector('.tutor-main-answer');
  const card = screen.getByRole('complementary', {
    name: 'Suggestion',
  });
  expect(main).toHaveTextContent('Here is the research summary.');
  expect(main).not.toHaveTextContent('Check study populations');
  expect(card).toHaveTextContent('Check study populations');
  expect(card).not.toHaveTextContent('Here is the research summary.');
  expect(main?.compareDocumentPosition(card)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(screen.getAllByText('Which paper fits your course?')).toHaveLength(1);
});

test('a coaching-only response has a card without an empty main answer', () => {
  const { container } = render(<TutorMessage text={guidance} />);
  expect(
    screen.getByRole('complementary', { name: 'Suggestion' }),
  ).toBeInTheDocument();
  expect(container.querySelector('.tutor-main-answer')).toBeNull();
});
