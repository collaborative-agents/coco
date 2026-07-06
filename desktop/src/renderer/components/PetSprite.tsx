import { useEffect, useState } from 'react';

import petIdle1 from '../../../assets/pet.png';
import sleep1 from '../../../assets/sleep1.png';
import sleep2 from '../../../assets/sleep2.png';
import sleep3 from '../../../assets/sleep3.png';
import sleep4 from '../../../assets/sleep4.png';
import sleep5 from '../../../assets/sleep5.png';
import sleep6 from '../../../assets/sleep6.png';
import tool1 from '../../../assets/tool1.png';
import tool2 from '../../../assets/tool2.png';
import tool3 from '../../../assets/tool3.png';
import tool4 from '../../../assets/tool4.png';
import wait1 from '../../../assets/wait1.png';
import wait2 from '../../../assets/wait2.png';
import wait3 from '../../../assets/wait3.png';
import wait4 from '../../../assets/wait4.png';
import write1 from '../../../assets/write1.png';
import write2 from '../../../assets/write2.png';
import write3 from '../../../assets/write3.png';
import write4 from '../../../assets/write4.png';

import type { PetMood } from './observation-types';

// Static moods → single still image, no interval. Avoids the constant bob
// pulling the user's eye during normal work; movement is reserved for moments
// when something actually changed (a new observation arrived → write/wait/
// tool/sleep packs).
const STATIC_FRAMES: Record<'dormant' | 'idle', string> = {
  dormant: sleep1, // pre-session — never received an observation yet
  idle: petIdle1, // post-event resting state
};

// Animation packs — each pool is played in array order on a setInterval.
const FRAMES: Record<Exclude<PetMood, 'dormant' | 'idle'>, string[]> = {
  write: [write1, write2, write3, write4],
  wait: [wait1, wait2, wait3, wait4],
  tool: [tool1, tool2, tool3, tool4],
  sleep: [sleep1, sleep2, sleep3, sleep4, sleep5, sleep6],
};

// Frames-per-second per animated mood. Tuned to feel ambient rather than
// twitchy — the pet should suggest activity, not demand attention.
const FPS: Record<Exclude<PetMood, 'dormant' | 'idle'>, number> = {
  write: 4,
  wait: 1.5,
  tool: 3,
  sleep: 1,
};

const isStatic = (m: PetMood): m is 'dormant' | 'idle' =>
  m === 'dormant' || m === 'idle';

export default function PetSprite({ mood }: { mood: PetMood }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (isStatic(mood)) {
      setFrame(0);
      return undefined;
    }
    // Restart at frame 0 whenever mood changes so the new pack reads cleanly
    // from the beginning rather than mid-cycle.
    setFrame(0);
    const frames = FRAMES[mood];
    const intervalMs = 1000 / FPS[mood];
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, intervalMs);
    return () => clearInterval(id);
  }, [mood]);

  const src = isStatic(mood) ? STATIC_FRAMES[mood] : FRAMES[mood][frame];
  // pet.png (the idle sprite) was authored at the design size — render it at
  // 100% while every other pack stays at the default 90%.
  const isFullScale = mood === 'idle';

  return (
    <img
      id="pet-image"
      src={src}
      alt="Desktop Pet"
      draggable={false}
      className={`pet-image${isFullScale ? ' pet-image-full' : ''}`}
    />
  );
}
