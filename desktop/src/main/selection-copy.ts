import { Menu, type BrowserWindow } from 'electron';

/** Copy the native selection, including partial message text, without relying
 * on the renderer Clipboard API or an application-wide Edit menu. */
export default function enableSelectionCopy(window: BrowserWindow) {
  window.webContents.on('before-input-event', (event, input) => {
    const modifier = process.platform === 'darwin' ? input.meta : input.control;
    if (
      input.type === 'keyDown' &&
      modifier &&
      !input.alt &&
      !input.shift &&
      !input.isComposing &&
      input.key.toLowerCase() === 'c'
    ) {
      event.preventDefault();
      window.webContents.copy();
    }
  });
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.selectionText) return;
    Menu.buildFromTemplate([
      { label: 'Copy', click: () => window.webContents.copy() },
    ]).popup({ window });
  });
}
