import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';

/** Shared desktop-sized setup surface, kept inside the current display. */
export default function setupWindowOptions(
  workArea: Rectangle,
): BrowserWindowConstructorOptions {
  const width = Math.min(1120, workArea.width);
  const height = Math.min(780, workArea.height);
  return {
    show: false,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
    minWidth: Math.min(760, width),
    minHeight: Math.min(600, height),
    backgroundColor: '#f8f9fb',
    frame: false,
    hasShadow: true,
    alwaysOnTop: false,
    resizable: true,
    skipTaskbar: false,
  };
}
