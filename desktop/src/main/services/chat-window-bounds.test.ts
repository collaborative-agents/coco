import resizeBoundsKeepingRightEdge from './chat-window-bounds';

const workArea = { x: 0, y: 0, width: 1440, height: 900 };

describe('resizeBoundsKeepingRightEdge', () => {
  it('expands to the left and collapses with the right edge fixed', () => {
    const narrow = { x: 500, y: 70, width: 420, height: 760 };

    const expanded = resizeBoundsKeepingRightEdge(narrow, workArea, 820, 16);
    const collapsed = resizeBoundsKeepingRightEdge(expanded, workArea, 420, 16);

    expect(expanded).toEqual({ x: 100, y: 70, width: 820, height: 760 });
    expect(collapsed).toEqual(narrow);
  });

  it('clamps a resized window inside the display work area', () => {
    const nearRightEdge = { x: 1004, y: 70, width: 420, height: 760 };

    expect(
      resizeBoundsKeepingRightEdge(nearRightEdge, workArea, 820, 16),
    ).toEqual({
      x: 604,
      y: 70,
      width: 820,
      height: 760,
    });
  });

  it('preserves position correctly on a display with negative coordinates', () => {
    const leftDisplay = { x: -1440, y: 0, width: 1440, height: 900 };
    const narrow = { x: -940, y: 70, width: 420, height: 760 };

    expect(resizeBoundsKeepingRightEdge(narrow, leftDisplay, 820, 16)).toEqual({
      x: -1340,
      y: 70,
      width: 820,
      height: 760,
    });
  });

  it('preserves a custom user-selected size when reopening the window', () => {
    const custom = { x: 320, y: 120, width: 680, height: 610 };

    expect(
      resizeBoundsKeepingRightEdge(custom, workArea, custom.width, 16),
    ).toEqual(custom);
  });
});
