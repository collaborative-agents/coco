import {
  avatarRecoveryItems,
  cocoNavigationItems,
  placeAvatarMenu,
} from './avatar-menu';

it('shares the avatar navigation order and routes each tray shortcut', () => {
  const actions = {
    'open-main-window': jest.fn(),
    'open-chat-settings': jest.fn(),
  };
  const items = cocoNavigationItems(actions);
  expect(items.map(({ label }) => label)).toEqual([
    'Open Chat',
    'Settings',
  ]);
  items.forEach((item) => (item.click as () => void)());
  Object.values(actions).forEach((action) =>
    expect(action).toHaveBeenCalledTimes(1),
  );
});

describe('Tray avatar recovery', () => {
  it('offers a direct restore action when the avatar is hidden', () => {
    const show = jest.fn();
    const items = avatarRecoveryItems(true, show);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Show Coco');
    (items[0].click as () => void)();
    expect(show).toHaveBeenCalledTimes(1);
  });
  it('does not offer restore when the avatar is already visible', () => {
    expect(avatarRecoveryItems(false, jest.fn())).toEqual([]);
  });
});

describe('placeAvatarMenu', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const menu = { width: 164, height: 254 };

  it('opens above Coco, right-aligned as before', () => {
    expect(placeAvatarMenu({ x: 700, y: 500 }, menu, workArea)).toEqual({
      x: 700 + 148 - 164,
      y: 500 + 25 - 254,
      below: false,
    });
  });

  it('drops down over Coco when there is no room above', () => {
    expect(placeAvatarMenu({ x: 700, y: 30 }, menu, workArea)).toEqual({
      x: 684,
      y: 86,
      below: true,
    });
  });

  it('keeps the menu on-screen when Coco is partly past a side edge', () => {
    expect(placeAvatarMenu({ x: -50, y: 500 }, menu, workArea).x).toBe(4);
    expect(placeAvatarMenu({ x: 1400, y: 500 }, menu, workArea).x).toBe(
      1440 - 4 - 164,
    );
  });
});
