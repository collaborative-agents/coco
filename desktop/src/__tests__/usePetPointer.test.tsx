import { act, fireEvent, render } from '@testing-library/react';
import usePetPointer from '../renderer/components/usePetPointer';
import { imageMask } from '../renderer/components/pet-hit-test';

jest.mock('../renderer/components/pet-hit-test', () => ({
  ...jest.requireActual('../renderer/components/pet-hit-test'),
  imageMask: jest.fn(),
}));

function Pet() {
  usePetPointer();
  return <img id="pet-image" alt="pet" />;
}

it('switches click-through on frame changes without mouse movement and cleans up', () => {
  let position: ((value: unknown) => void) | undefined;
  const remove = jest.fn();
  const sendMessage = jest.fn();
  (window as any).electron = {
    ipcRenderer: {
      sendMessage,
      on: (_: string, callback: (value: unknown) => void) => {
        position = callback;
        return remove;
      },
    },
  };
  const mask = { width: 2, height: 1, alpha: new Uint8Array([255, 0]) };
  (imageMask as jest.Mock).mockReturnValue(mask);
  const { unmount } = render(<Pet />);
  const img = document.querySelector('img')!;
  img.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 20, height: 10 }) as DOMRect;
  act(() => position?.({ x: 5, y: 5 }));
  expect(sendMessage).toHaveBeenLastCalledWith('avatar-pointer', {
    inside: true,
  });
  img.setPointerCapture = jest.fn();
  img.hasPointerCapture = jest.fn().mockReturnValue(true);
  img.releasePointerCapture = jest.fn();
  const down = new MouseEvent('pointerdown', {
    bubbles: true,
    button: 0,
    clientX: 5,
    clientY: 5,
  });
  Object.defineProperty(down, 'pointerId', { value: 1 });
  fireEvent(img, down);
  expect(img.setPointerCapture).toHaveBeenCalledWith(1);
  expect(sendMessage).toHaveBeenLastCalledWith('avatar-pointer-drag', {
    phase: 'start',
  });
  act(() => position?.({ x: 100, y: 100 }));
  expect(sendMessage).not.toHaveBeenLastCalledWith('avatar-pointer', {
    inside: false,
  });
  fireEvent(
    window,
    new MouseEvent('pointermove', { clientX: 100, clientY: 100 }),
  );
  expect(sendMessage).toHaveBeenCalledWith('avatar-pointer-drag', {
    phase: 'move',
  });
  fireEvent(window, new MouseEvent('pointerup'));
  expect(img.releasePointerCapture).toHaveBeenCalledWith(1);
  expect(sendMessage).toHaveBeenLastCalledWith('avatar-pointer-drag', {
    phase: 'end',
  });
  act(() => position?.({ x: 15, y: 5 }));
  expect(sendMessage).toHaveBeenLastCalledWith('avatar-pointer', {
    inside: false,
  });
  mask.alpha[1] = 255;
  act(() => position?.({ x: 15, y: 5 }));
  expect(sendMessage).toHaveBeenLastCalledWith('avatar-pointer', {
    inside: true,
  });
  unmount();
  expect(remove).toHaveBeenCalled();
  expect(sendMessage).toHaveBeenLastCalledWith('avatar-pointer', {
    inside: false,
  });
  delete (window as any).electron;
});
