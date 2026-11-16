import React, { useEffect, useState } from 'react';
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

export function AnimatedCocoGif({
  id,
  size,
  frameIntervalMs,
}: {
  id: CocoGifId;
  size: number;
  frameIntervalMs?: number;
}) {
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
      frameIntervalMs ?? definition.intervalMs,
    );
    return () => window.clearInterval(timer);
  }, [definition, frameIntervalMs]);

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

AnimatedCocoGif.defaultProps = {
  frameIntervalMs: undefined,
};
