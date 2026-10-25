import isChatOutOfView from '../main/services/chat-visibility';

const chatWindow = () => ({
  isDestroyed: jest.fn(() => false),
  isVisible: jest.fn(() => true),
  isMinimized: jest.fn(() => false),
  isFocused: jest.fn(() => false),
  webContents: { executeJavaScript: jest.fn().mockResolvedValue(false) },
});

describe('reply reminder visibility', () => {
  it('does nothing for visible chat, even without focus', async () => {
    expect(await isChatOutOfView(chatWindow())).toBe(false);
  });

  it('reminds for closed, hidden, and minimized chat', async () => {
    expect(await isChatOutOfView(null)).toBe(true);
    const hidden = chatWindow();
    hidden.isVisible.mockReturnValue(false);
    expect(await isChatOutOfView(hidden)).toBe(true);
    expect(hidden.webContents.executeJavaScript).not.toHaveBeenCalled();
    const minimized = chatWindow();
    minimized.isMinimized.mockReturnValue(true);
    expect(await isChatOutOfView(minimized)).toBe(true);
  });

  it('uses native page visibility for another macOS Space or occluded chat', async () => {
    const window = chatWindow();
    window.webContents.executeJavaScript.mockResolvedValue(true);
    expect(await isChatOutOfView(window)).toBe(true);
    // The user may have switched back during the asynchronous query.
    window.isFocused.mockReturnValue(true);
    expect(await isChatOutOfView(window)).toBe(false);
  });

  it('does not interrupt when visibility cannot be determined', async () => {
    const window = chatWindow();
    window.webContents.executeJavaScript.mockRejectedValue(new Error('gone'));
    expect(await isChatOutOfView(window)).toBe(false);
  });
});
