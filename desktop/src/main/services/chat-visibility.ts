/** Only the chat window's visibility matters, not whether it has keyboard focus. */
interface ChatWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  webContents: { executeJavaScript(code: string): Promise<unknown> };
}

export default async function isChatOutOfView(
  window: ChatWindow | null,
): Promise<boolean> {
  if (!window || window.isDestroyed()) return true;
  if (!window.isVisible() || window.isMinimized()) return true;
  try {
    // Requires backgroundThrottling enabled. On macOS this includes occlusion
    // and windows on another Space; focus alone would misclassify visible chat.
    const hidden =
      await window.webContents.executeJavaScript('document.hidden');
    return hidden === true && !window.isFocused();
  } catch {
    // Unknown visibility should not cause an unnecessary interruption.
    return false;
  }
}
