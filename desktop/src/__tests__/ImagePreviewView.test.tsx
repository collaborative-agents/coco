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

  it('offers drawing tools and saves an editable screenshot as a PNG', async () => {
    const listeners = new Map<string, (data: unknown) => void>();
    const sendMessage = jest.fn();
    const context = {
      beginPath: jest.fn(),
      clearRect: jest.fn(),
      drawImage: jest.fn(),
      fillRect: jest.fn(),
      fillText: jest.fn(),
      lineTo: jest.fn(),
      moveTo: jest.fn(),
      restore: jest.fn(),
      save: jest.fn(),
      stroke: jest.fn(),
      strokeRect: jest.fn(),
      strokeText: jest.fn(),
      translate: jest.fn(),
    };
    const getContext = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const toDataUrl = jest
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,YW5ub3RhdGVk');
    const NativeImage = window.Image;
    class LoadedImage {
      naturalWidth = 800;

      naturalHeight = 600;

      width = 800;

      height = 600;

      onload: (() => void) | null = null;

      set src(_value: string) {
        this.onload?.();
      }
    }
    Object.defineProperty(window, 'Image', {
      configurable: true,
      value: LoadedImage,
    });
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
    act(() => {
      listeners.get('image-preview')?.({
        imageDataUrl: 'data:image/png;base64,cHJldmlldw==',
        editable: true,
        fullScreenOverlay: true,
      });
    });

    expect(
      await screen.findByText('Drag to select an area · Esc to cancel'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('toolbar', { name: 'Screenshot annotation tools' }),
    ).not.toBeInTheDocument();

    const canvas = screen.getByLabelText('Screenshot annotation canvas');
    expect(canvas).toHaveStyle({
      width: '100vw',
      height: '100vh',
    });
    expect(canvas).toHaveAttribute('width', '800');
    expect(canvas).toHaveAttribute('height', '600');
    let capturedPointer = false;
    Object.assign(canvas, {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
      setPointerCapture: () => {
        capturedPointer = true;
      },
      hasPointerCapture: () => capturedPointer,
      releasePointerCapture: () => {
        capturedPointer = false;
      },
    });
    const pointerEvent = (type: string, clientX: number, clientY: number) =>
      fireEvent(
        canvas,
        new MouseEvent(type, { bubbles: true, clientX, clientY }),
      );
    pointerEvent('pointerdown', 80, 60);
    pointerEvent('pointermove', 640, 480);
    pointerEvent('pointerup', 640, 480);

    const toolbar = await screen.findByRole('toolbar', {
      name: 'Screenshot annotation tools',
    });
    expect(toolbar).toHaveStyle({ borderRadius: '14px' });
    expect(screen.getByRole('button', { name: 'Pen' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Arrow' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Rectangle' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Text' })).toBeEnabled();
    expect(
      sendMessage.mock.calls.filter(
        ([channel]) => channel === 'image-preview-ready',
      ),
    ).toHaveLength(1);

    context.stroke.mockClear();
    pointerEvent('pointerdown', 100, 80);
    pointerEvent('pointermove', 160, 120);
    pointerEvent('pointerup', 160, 120);
    expect(
      screen.getByRole('button', { name: 'Undo annotation' }),
    ).toBeEnabled();
    expect(context.stroke).toHaveBeenCalled();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Save selected screenshot' }),
    );
    expect(toDataUrl).toHaveBeenCalledWith('image/png');
    expect(toDataUrl.mock.instances[0]).toHaveProperty('width', 560);
    expect(toDataUrl.mock.instances[0]).toHaveProperty('height', 420);
    expect(sendMessage).toHaveBeenCalledWith('save-image-annotation', {
      imageDataUrl: 'data:image/png;base64,YW5ub3RhdGVk',
    });

    getContext.mockRestore();
    toDataUrl.mockRestore();
    Object.defineProperty(window, 'Image', {
      configurable: true,
      value: NativeImage,
    });
  });
});
