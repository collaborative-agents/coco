import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { TutorMessage } from './MessageContent';
import { NotificationBubble } from '../NotificationView';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
});

const source = Array.from(
  { length: 24 },
  (_, index) => `const value${index} = "example";`,
).join('\n');
['chat', 'notification'].forEach((kind) => {
  const show = (text: string) =>
    render(
      kind === 'chat' ? (
        <TutorMessage text={text} />
      ) : (
        <NotificationBubble message={text} expanded />
      ),
    );
  test(`${kind} collapses long response code and opens complete highlighted source`, () => {
    const { container } = show(
      `Here is the code:\n\n\`\`\`javascript\n${source}\n\`\`\`\n\nAfter the code.`,
    );
    expect(container).toHaveTextContent('Here is the code:');
    expect(container).toHaveTextContent('After the code.');
    expect(container).not.toHaveTextContent('value23');
    const expand = screen.getByRole('button', { name: 'Show full code block' });
    expect(expand).toHaveTextContent('+ 20 lines');
    fireEvent.click(expand);
    const modal = screen.getByRole('dialog', { name: 'javascript code' });
    expect(modal.querySelector('code')!.textContent).toBe(`${source}\n`);
    expect(modal.querySelector('.hljs-keyword')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close code window' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test(`${kind} keeps short blocks and inline code unchanged`, () => {
    const { container } = show(
      'Use `const x = 1`:\n\n```javascript\nconst x = 1;\n```',
    );
    expect(container.querySelectorAll('code')).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: 'Show full code block' }),
    ).toBeNull();
    expect(container.querySelector('pre')!.textContent).toBe('const x = 1;\n');
  });
});

test('handles unknown languages and very long single lines without losing text', () => {
  const text = '<custom>'.repeat(100);
  render(<TutorMessage text={`\`\`\`unknown-language\n${text}\n\`\`\``} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show full code block' }));
  const modal = screen.getByRole('dialog');
  expect(modal.querySelector('code')!.textContent).toBe(`${text}\n`);
  expect(modal.querySelector('custom')).toBeNull();
});
