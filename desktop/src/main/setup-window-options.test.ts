import setupWindowOptions from './setup-window-options';

describe('setup window sizing', () => {
  it('centers a desktop-sized window within the display work area', () => {
    expect(
      setupWindowOptions({ x: 1440, y: 40, width: 1600, height: 1000 }),
    ).toMatchObject({
      width: 1120,
      height: 780,
      x: 1680,
      y: 150,
      resizable: true,
      alwaysOnTop: false,
      skipTaskbar: false,
    });
  });

  it('keeps the window and resize minimum within a small display', () => {
    expect(
      setupWindowOptions({ x: 0, y: 24, width: 700, height: 540 }),
    ).toMatchObject({
      width: 700,
      height: 540,
      minWidth: 700,
      minHeight: 540,
      x: 0,
      y: 24,
    });
  });
});
