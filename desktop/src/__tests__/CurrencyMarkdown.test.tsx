import { render } from '@testing-library/react';
import { NotificationBubble } from '../renderer/components/NotificationView';
import { TutorMessage } from '../renderer/components/chat/MessageContent';

const payments = `**PAYMENTS:** Six $50 performance awards will be offered.

- **Top 3 Most Improved ($50 each per group):** Awarded for improvement.

*[Optional: Each participant is eligible to receive at most one $50 award; if a participant qualifies in both categories, the second award will go to the next highest-ranking participant.]* Awards will be delivered electronically as a $50 gift card via Amazon or Tremendous.`;

for (const kind of ['chat', 'notification']) {
  describe(`${kind} currency rendering`, () => {
    const show = (text: string) =>
      render(
        kind === 'chat' ? (
          <TutorMessage text={text} />
        ) : (
          <NotificationBubble message={text} expanded />
        ),
      );

    it('keeps payment amounts and prose readable with markdown formatting', () => {
      const { container } = show(payments);
      expect(container.querySelector('.katex')).toBeNull();
      expect(container.textContent?.match(/\$50/g)).toHaveLength(4);
      expect(container.querySelector('em')?.textContent).toContain(
        '$50 award;',
      );
      expect(container.querySelector('strong')?.textContent).toBe('PAYMENTS:');
      expect(container.textContent).toContain('$50 gift card via Amazon');
    });

    it('preserves math alongside currency', () => {
      const { container } = show(
        'Pay $50 each or $100 total. Compute $2 + 2$ and $x^2$.',
      );
      expect(container.textContent).toContain('Pay $50 each or $100 total.');
      expect(container.querySelectorAll('.katex')).toHaveLength(2);
    });

    it('preserves literal dollars in code and escaped amounts', () => {
      const { container } = show(
        '`$50 each` and \\$50 each.\n\n```text\n$100 total\n```',
      );
      expect(container.querySelectorAll('code')[0].textContent).toBe(
        '$50 each',
      );
      expect(container.querySelectorAll('code')[1].textContent).toContain(
        '$100 total',
      );
      expect(container.textContent).not.toContain('\\$');
      expect(container.querySelector('.katex')).toBeNull();
    });
  });
}
