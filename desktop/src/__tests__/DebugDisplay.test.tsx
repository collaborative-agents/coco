import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { NotificationBubble } from '../renderer/components/NotificationView';

it('debug display math output', () => {
  const { container } = render(<NotificationBubble message={'$$E = mc^2$$'} />);
  console.log('HTML:', container.innerHTML.substring(0, 800));
  console.log('Classes:', [...container.querySelectorAll('[class]')].map(e => e.className).join(', '));
});
