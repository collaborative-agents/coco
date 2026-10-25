import React from 'react';

export type Rating = 'up' | 'down';

const DEFAULT_LABELS: Record<Rating, string> = {
  up: 'Helpful',
  down: 'Not helpful',
};

function ThumbIcon({ filled, down }: { filled: boolean; down: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={down ? { transform: 'rotate(180deg)' } : undefined}
    >
      <path d="M7 10v11" />
      <path d="M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z" />
    </svg>
  );
}

/**
 * Thumbs up/down used everywhere Coco asks for a rating. The chosen thumb is
 * filled navy; both stay clickable so a rating can be changed.
 */
export default function RatingButtons({
  value,
  onRate,
  labels = DEFAULT_LABELS,
  className,
}: {
  value: Rating | null | undefined;
  onRate: (rating: Rating) => void;
  labels?: Record<Rating, string>;
  className?: string;
}) {
  return (
    <div
      className={`coco-rating${className ? ` ${className}` : ''}`}
      role="group"
      aria-label="Rate this"
    >
      {(['up', 'down'] as const).map((rating) => {
        const selected = value === rating;
        return (
          <button
            key={rating}
            type="button"
            className={`coco-rating-btn${selected ? ' is-selected' : ''}`}
            aria-label={labels[rating]}
            aria-pressed={selected}
            title={labels[rating]}
            onClick={() => {
              if (!selected) onRate(rating);
            }}
          >
            <ThumbIcon filled={selected} down={rating === 'down'} />
          </button>
        );
      })}
    </div>
  );
}
