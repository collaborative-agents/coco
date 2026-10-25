import type { BrowserWindow } from 'electron';

type MainWindow = Pick<
  BrowserWindow,
  'setAlwaysOnTop' | 'setVisibleOnAllWorkspaces'
>;

/** The main app follows normal window stacking, unlike the desktop avatar. */
export default function configureMainWindow(
  window: MainWindow,
  platform: string = process.platform,
) {
  window.setAlwaysOnTop(false);
  if (platform === 'darwin') window.setVisibleOnAllWorkspaces(false);
}

/** Resize in place; move left only when expansion would leave the display. */
export function resizeMainWindow(
  window: Pick<
    BrowserWindow,
    'getBounds' | 'setBounds' | 'isMaximized' | 'isFullScreen'
  >,
  width: number,
  workArea: { x: number; width: number },
) {
  if (window.isMaximized() || window.isFullScreen()) return;
  const bounds = window.getBounds();
  const fittedWidth = Math.min(width, workArea.width);
  if (bounds.width === fittedWidth) return;
  const x = Math.max(
    workArea.x,
    Math.min(bounds.x, workArea.x + workArea.width - fittedWidth),
  );
  window.setBounds({ ...bounds, x, width: fittedWidth });
}
