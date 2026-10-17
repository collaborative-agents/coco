import { HiddenAvatarVisibility } from './hidden-avatar-visibility';

describe('HiddenAvatarVisibility', () => {
  it('keeps the daily review visible when History closes', () => {
    const visibility = new HiddenAvatarVisibility();

    visibility.setVisible('daily-memory-review', true);
    visibility.setVisible('history', false);

    expect(visibility.shouldShowWindow()).toBe(true);

    visibility.setVisible('daily-memory-review', false);
    expect(visibility.shouldShowWindow()).toBe(false);
  });
});
