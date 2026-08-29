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

  it('keeps a hidden avatar revealed until its social alert closes', () => {
    const visibility = new HiddenAvatarVisibility();

    visibility.setVisible('social-notification', true);
    expect(visibility.shouldShowWindow()).toBe(true);

    visibility.setVisible('social-notification', false);
    expect(visibility.shouldShowWindow()).toBe(false);
  });
});
