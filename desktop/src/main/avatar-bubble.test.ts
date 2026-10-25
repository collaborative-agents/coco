import { avatarBubbleMaxHeight, placeAvatarBubble } from './avatar-bubble';

describe('placeAvatarBubble', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const card = { width: 220, height: 120 };

  it('puts the card to the left of Coco with its tail beside the pet', () => {
    expect(placeAvatarBubble({ x: 1000, y: 600 }, card, workArea)).toEqual({
      x: 1000 + 18 - 220,
      y: 600 + 180 - 24 - 120,
      side: 'left',
      // Coco's middle (98px into its footprint), from the card's top.
      tailY: 600 + 98 - (600 + 180 - 24 - 120),
    });
  });

  it('slides the card down instead of off the top when Coco is high up', () => {
    const tall = { width: 320, height: 460 };
    const placed = placeAvatarBubble({ x: 1000, y: 30 }, tall, workArea);
    expect(placed.y).toBe(workArea.y + 8);
    expect(placed.side).toBe('left');
  });

  it("moves to Coco's right when there is no room on the left", () => {
    expect(placeAvatarBubble({ x: 40, y: 600 }, card, workArea)).toMatchObject({
      x: 40 + 180 - 18,
      y: 600 + 180 - 24 - 120,
      side: 'right',
    });
  });

  it('stays on the left, kept on screen, when neither side has room', () => {
    const narrow = { x: 0, y: 25, width: 400, height: 875 };
    const wide = { width: 320, height: 120 };
    const placed = placeAvatarBubble({ x: 100, y: 600 }, wide, narrow);
    expect(placed.side).toBe('left');
    expect(placed.x).toBe(8);
  });

  it('respects a work area on a secondary display', () => {
    const second = { x: 1440, y: 0, width: 1920, height: 1080 };
    const placed = placeAvatarBubble({ x: 1450, y: 500 }, card, second);
    expect(placed.side).toBe('right');
    expect(placed.x).toBe(1450 + 162);
  });
});

describe('placeAvatarBubble for the Activity panel', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const panel = { width: 252, height: 480 };
  const options = { align: 'center' as const, insetX: 10 };

  it('centers the panel on Coco, with the tail at its middle', () => {
    const placed = placeAvatarBubble(
      { x: 1000, y: 300 },
      panel,
      workArea,
      options,
    );
    expect(placed).toEqual({
      x: 1000 + 10 - 252,
      y: 300 + 98 - 240,
      side: 'left',
      tailY: 240,
    });
  });

  it('keeps the tail on Coco when the panel is held on screen', () => {
    const placed = placeAvatarBubble(
      { x: 1000, y: 40 },
      panel,
      workArea,
      options,
    );
    expect(placed.y).toBe(workArea.y + 8);
    expect(placed.tailY).toBe(40 + 98 - placed.y);
  });

  it('keeps the tail clear of the corners when Coco is past the panel', () => {
    const placed = placeAvatarBubble(
      { x: 1000, y: 820 },
      panel,
      workArea,
      options,
    );
    expect(placed.tailY).toBe(480 - 22);
  });
});

it('caps the card height to the work area, leaving room for padding', () => {
  expect(
    avatarBubbleMaxHeight({ x: 0, y: 25, width: 1440, height: 875 }, 24),
  ).toBe(875 - 64);
});
