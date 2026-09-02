import React, { useCallback, useEffect, useRef, useState } from 'react';
import pet1 from '../../../assets/pet1.png';
import pet2 from '../../../assets/pet2.png';
import pet3 from '../../../assets/pet3.png';
import pet4 from '../../../assets/pet4.png';
import sleep1 from '../../../assets/sleep1.png';
import sleep2 from '../../../assets/sleep2.png';
import sleep3 from '../../../assets/sleep3.png';
import trainingAnimation from '../../../assets/training.gif';
import wait1 from '../../../assets/wait1.png';
import wait2 from '../../../assets/wait2.png';
import wait3 from '../../../assets/wait3.png';
import wait4 from '../../../assets/wait4.png';
import write1 from '../../../assets/write1.png';
import write2 from '../../../assets/write2.png';
import write3 from '../../../assets/write3.png';
import useDismissiblePopover from './useDismissiblePopover';

export const COCO_GIF_IDS = [
  'working',
  'sleepy',
  'waiting',
  'writing',
  'celebrate',
] as const;

export type CocoGifId = (typeof COCO_GIF_IDS)[number];

interface CocoGifDefinition {
  label: string;
  frames: string[];
  intervalMs: number;
}

const COCO_GIFS: Record<CocoGifId, CocoGifDefinition> = {
  working: {
    label: 'Working Coco',
    frames: [pet1, pet2, pet3, pet4],
    intervalMs: 320,
  },
  sleepy: {
    label: 'Sleepy Coco',
    frames: [sleep1, sleep2, sleep3],
    intervalMs: 420,
  },
  waiting: {
    label: 'Waiting Coco',
    frames: [wait1, wait2, wait3, wait4],
    intervalMs: 360,
  },
  writing: {
    label: 'Writing Coco',
    frames: [write1, write2, write3],
    intervalMs: 300,
  },
  celebrate: {
    label: 'Celebrating Coco',
    frames: [trainingAnimation],
    intervalMs: 400,
  },
};

export function isCocoGifId(value: unknown): value is CocoGifId {
  return COCO_GIF_IDS.includes(value as CocoGifId);
}

export function cocoGifLabel(id: CocoGifId): string {
  return COCO_GIFS[id].label;
}

export function AnimatedCocoGif({ id, size }: { id: CocoGifId; size: number }) {
  const definition = COCO_GIFS[id];
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    setFrameIndex(0);
    if (
      definition.frames.length < 2 ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      return undefined;
    }
    const timer = window.setInterval(
      () =>
        setFrameIndex((current) => (current + 1) % definition.frames.length),
      definition.intervalMs,
    );
    return () => window.clearInterval(timer);
  }, [definition]);

  return (
    <img
      src={definition.frames[frameIndex]}
      alt={definition.label}
      draggable={false}
      style={{
        display: 'block',
        width: size,
        maxWidth: '100%',
        aspectRatio: '1 / 1',
        objectFit: 'contain',
        userSelect: 'none',
      }}
    />
  );
}

export function CocoGifPicker({
  label,
  disabled,
  onSelect,
}: {
  label: string;
  disabled: boolean;
  onSelect: (id: CocoGifId) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissiblePopover(containerRef, open, dismiss);

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: '0 0 auto' }}>
      {open && (
        <div
          role="group"
          aria-label={label}
          style={{
            position: 'absolute',
            zIndex: 6,
            left: 0,
            bottom: 'calc(100% + 5px)',
            width: 230,
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 5,
            border: '1px solid #e5e7eb',
            borderRadius: 11,
            padding: 7,
            background: '#fff',
            boxShadow: '0 6px 18px rgba(15, 23, 42, 0.15)',
          }}
        >
          {COCO_GIF_IDS.map((id) => (
            <button
              key={id}
              type="button"
              aria-label={`Send ${cocoGifLabel(id)}`}
              style={{
                minWidth: 0,
                border: '1px solid #e5e7eb',
                borderRadius: 9,
                padding: 3,
                background: '#f9fafb',
                cursor: 'pointer',
              }}
              onClick={() => {
                onSelect(id);
                setOpen(false);
              }}
            >
              <AnimatedCocoGif id={id} size={64} />
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        style={{
          height: 28,
          border: '1px solid #e5e7eb',
          borderRadius: 7,
          padding: '0 7px',
          background: '#fff',
          color: '#204A79',
          cursor: disabled ? 'default' : 'pointer',
          fontSize: 10.5,
          fontWeight: 700,
          opacity: disabled ? 0.5 : 1,
        }}
        onClick={() => setOpen((current) => !current)}
      >
        GIF
      </button>
    </div>
  );
}
