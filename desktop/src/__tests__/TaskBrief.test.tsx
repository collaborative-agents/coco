import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import parseTaskBrief, {
  briefParagraphs,
} from '../renderer/components/training/task-brief';
import PdfTaskBrief from '../renderer/components/training/PdfTaskBrief';
import extractPdfText from '../renderer/components/training/extract-pdf-text';

jest.mock('../renderer/components/training/extract-pdf-text', () => ({
  __esModule: true,
  default: jest.fn(),
}));
const source = `Day 3 — Product Selection
BrightNest Living · Campaign Readiness Sprint · Day 3 of 7
Story context
Choose one product for the campaign.
What you have
• lineup.csv — product evidence

These files are the complete evidence base. Do not use outside sources.
What to do
• Pick exactly one product.
• Explain the trade-off
and show your calculations.
Deliverables
• A decision memo.
Acceptance checklist
• Explain what would change your decision.
What not to do (non-goals)
• Do not invent data.
`;

it('extracts task sections without dropping evidence limits, deliverables, or constraints', () => {
  const result = parseTaskBrief(source, 'instruction.pdf');
  expect(result.title).toBe('Product Selection');
  expect(result.sections.map((section) => section.title)).toEqual([
    'Background',
    'Reference files',
    'Your task',
    'Deliverables',
    'Success checklist',
    'Keep in mind',
  ]);
  expect(result.sections[1].text).toContain('Do not use outside sources');
  expect(result.sections.at(-1)?.text).toContain('Do not invent data');
  expect(briefParagraphs(result.sections[2].text)).toEqual([
    { list: true, text: 'Pick exactly one product.' },
    { list: true, text: 'Explain the trade-off and show your calculations.' },
  ]);
});

it('renders native task content without embedding a PDF', async () => {
  (extractPdfText as jest.Mock).mockResolvedValue(source);
  const { container } = render(
    <PdfTaskBrief
      document={{
        id: 'task.pdf',
        name: 'task.pdf',
        kind: 'pdf',
        content: 'encoded-pdf',
      }}
    />,
  );
  expect(
    await screen.findByRole('heading', { name: 'Product Selection' }),
  ).toBeInTheDocument();
  expect(screen.getByText('Do not invent data.')).toBeInTheDocument();
  expect(
    screen.getByRole('heading', { name: 'Deliverables' }),
  ).toBeInTheDocument();
  expect(container.querySelector('iframe')).toBeNull();
  expect(extractPdfText).toHaveBeenCalledWith('encoded-pdf');
});

it('supports retrying unreadable instructions', async () => {
  (extractPdfText as jest.Mock)
    .mockRejectedValueOnce(new Error('PDF has no selectable text'))
    .mockResolvedValueOnce(source);
  render(
    <PdfTaskBrief
      document={{
        id: 'task.pdf',
        name: 'task.pdf',
        kind: 'pdf',
        content: 'pdf',
      }}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'PDF has no selectable text',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry instructions' }));
  await waitFor(() =>
    expect(
      screen.getByRole('heading', { name: 'Product Selection' }),
    ).toBeInTheDocument(),
  );
});
