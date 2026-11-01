import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import '../App.css';
import './AvatarBubbleView.css';
import ObservationBubble, { type BubbleState } from './ObservationBubble';

/** Bubble interactions, handled by the avatar renderer that owns the bubble. */
export type AvatarBubbleEvent =
  | 'help'
  | 'dismiss'
  | 'view-conversation'
  | 'chat'
  | 'run'
  | 'enter'
  | 'leave';

const sendEvent = (type: AvatarBubbleEvent) =>
  window.electron?.ipcRenderer.sendMessage('avatar-bubble-event', type);

const setPointerInside = (inside: boolean) =>
  window.electron?.ipcRenderer.sendMessage('avatar-bubble-pointer', { inside });

/**
 * Coco's observation bubble, rendered in its own window beside the avatar.
 * Main sizes and places the window from the card size reported here, and
 * reveals it once a new bubble has been painted.
 */
export default function AvatarBubbleView() {
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [side, setSide] = useState<'left' | 'right'>('left');
  // The window gets no mouse events while hidden, so a new bubble would show
  // the button last hovered (often ×) as still hovered. Its buttons react to
  // the pointer only once it actually moves over the window again. Chromium
  // also fires mousemove when content changes under a resting cursor; those
  // repeat the last position, so they don't count as movement.
  const [pointerLive, setPointerLive] = useState(false);
  const bubbleKeyRef = useRef<string | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const shown = bubble != null;

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    const removeState = ipc?.on('avatar-bubble-state', (value: unknown) => {
      const data = value as
        | { bubble?: BubbleState | null; maxHeight?: number }
        | undefined;
      setBubble(data?.bubble ?? null);
      const next = data?.bubble;
      const key = next
        ? `${next.status}|${next.phrase}|${next.observationId ?? ''}`
        : null;
      if (key !== bubbleKeyRef.current) {
        bubbleKeyRef.current = key;
        setPointerLive(false);
      }
      if (typeof data?.maxHeight === 'number') setMaxHeight(data.maxHeight);
      // A new or cleared bubble starts with the mouse outside it.
      if (!data?.bubble) setPointerInside(false);
    });
    const removePlacement = ipc?.on(
      'avatar-bubble-placement',
      (value: unknown) => {
        setSide(
          (value as { side?: string } | undefined)?.side === 'right'
            ? 'right'
            : 'left',
        );
      },
    );
    return () => {
      if (typeof removeState === 'function') removeState();
      if (typeof removePlacement === 'function') removePlacement();
    };
  }, []);

  // Report the card's layout box (unaffected by its entry animation) whenever
  // its content changes size.
  useLayoutEffect(() => {
    const card = shown
      ? viewRef.current?.querySelector<HTMLElement>('.observation-bubble')
      : null;
    if (!card) return undefined;
    const report = () =>
      window.electron?.ipcRenderer.sendMessage('avatar-bubble-size', {
        width: card.offsetWidth,
        height: card.offsetHeight,
      });
    report();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(report);
    observer.observe(card);
    return () => observer.disconnect();
  }, [shown]);

  // Two animation frames: the first runs before the new layout is painted,
  // the second after it.
  useEffect(() => {
    if (!shown) return undefined;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() =>
        window.electron?.ipcRenderer.sendMessage('avatar-bubble-painted'),
      );
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [shown]);

  return (
    <div
      ref={viewRef}
      className={`avatar-bubble-view is-${side}${pointerLive ? ' is-pointer-live' : ''}`}
      onMouseMove={(event) => {
        const last = lastPointerRef.current;
        const moved =
          !last || last.x !== event.screenX || last.y !== event.screenY;
        lastPointerRef.current = { x: event.screenX, y: event.screenY };
        if (moved && !pointerLive) setPointerLive(true);
      }}
      style={
        maxHeight
          ? ({ '--bubble-max-height': `${maxHeight}px` } as CSSProperties)
          : undefined
      }
    >
      <ObservationBubble
        bubble={bubble}
        onHelpMe={() => sendEvent('help')}
        onDismiss={() => sendEvent('dismiss')}
        onViewConversation={() => sendEvent('view-conversation')}
        onChatAboutSuggestion={() => sendEvent('chat')}
        onRunSuggestion={() => sendEvent('run')}
        onMouseEnter={() => {
          setPointerInside(true);
          sendEvent('enter');
        }}
        onMouseLeave={() => {
          setPointerInside(false);
          sendEvent('leave');
        }}
      />
    </div>
  );
}
