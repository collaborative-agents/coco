import { useEffect } from 'react';
import { hitsPet, imageMask } from './pet-hit-test';

export default function usePetPointer() {
  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    let captured: HTMLElement | null = null;
    let pointerId = 0;
    let lastInside: boolean | undefined;
    const foxHit = (x: number, y: number) => {
      const img = document.querySelector<HTMLImageElement>('#pet-image');
      if (!img) return false;
      const mask = imageMask(img);
      return Boolean(mask && hitsPet(mask, img.getBoundingClientRect(), x, y));
    };
    const update = (x: number, y: number) => {
      const button = document.querySelector<HTMLElement>(
        '.pet-actions-trigger',
      );
      const rect = button?.getBoundingClientRect();
      const visible =
        button &&
        Number(getComputedStyle(button).opacity) > 0 &&
        getComputedStyle(button).visibility !== 'hidden';
      const controlHit =
        visible &&
        rect &&
        x >= rect.left &&
        x < rect.right &&
        y >= rect.top &&
        y < rect.bottom;
      const inside = Boolean(captured || controlHit || foxHit(x, y));
      if (inside !== lastInside) {
        ipc?.sendMessage('avatar-pointer', { inside });
        lastInside = inside;
      }
    };
    // Main polls the screen cursor so stationary pointers, image changes and
    // movement over other applications all get re-evaluated.
    const unsubscribe = ipc?.on('avatar-pointer-position', (value: unknown) => {
      const point = value as { x: number; y: number };
      update(point.x, point.y);
    });
    const down = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        !(event.target instanceof HTMLElement) ||
        event.target.closest('button') ||
        !foxHit(event.clientX, event.clientY)
      )
        return;
      captured = event.target;
      pointerId = event.pointerId;
      captured.setPointerCapture(pointerId);
      ipc?.sendMessage('avatar-pointer-drag', { phase: 'start' });
      event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      if (captured) ipc?.sendMessage('avatar-pointer-drag', { phase: 'move' });
      update(event.clientX, event.clientY);
    };
    const end = () => {
      if (!captured) return;
      const element = captured;
      captured = null;
      if (element.hasPointerCapture(pointerId))
        element.releasePointerCapture(pointerId);
      ipc?.sendMessage('avatar-pointer-drag', { phase: 'end' });
      lastInside = undefined;
    };
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('lostpointercapture', end);
    window.addEventListener('blur', end);
    return () => {
      end();
      unsubscribe?.();
      ipc?.sendMessage('avatar-pointer', { inside: false });
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('lostpointercapture', end);
      window.removeEventListener('blur', end);
    };
  }, []);
}
