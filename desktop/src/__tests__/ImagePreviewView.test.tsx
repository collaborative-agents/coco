import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ImagePreviewView from '../renderer/components/ImagePreviewView';

describe('ImagePreviewView', () => {
  it('shows the image and closes from Escape or the backdrop', () => {
    const listeners = new Map<string, (data: unknown) => void>();
    const sendMessage = jest.fn();
    (window as any).electron = {
      ipcRenderer: {
        on: jest.fn((channel: string, callback: (data: unknown) => void) => {
          listeners.set(channel, callback);
          return jest.fn();
        }),
        sendMessage,
      },
    };

    render(<ImagePreviewView />);
    expect(sendMessage).toHaveBeenCalledWith('image-preview-ready');

    const imageDataUrl = 'data:image/png;base64,cHJldmlldw==';
    act(() => {
      listeners.get('image-preview')?.({ imageDataUrl });
    });

    expect(
      screen.getByRole('img', { name: 'Preview of attachment' }),
    ).toHaveAttribute('src', imageDataUrl);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sendMessage).toHaveBeenCalledWith('close-image-preview');

    sendMessage.mockClear();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Close image preview backdrop',
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith('close-image-preview');
  });
});
