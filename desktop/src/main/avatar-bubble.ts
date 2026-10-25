type Point = { x: number; y: number };
type Size = { width: number; height: number };
type Area = Point & Size;

const AVATAR_FOOTPRINT = 180;
const BUBBLE_SCREEN_MARGIN = 8;
// Where the card sat when it lived inside the avatar window: its right edge
// 18px inside Coco's footprint and its bottom edge 24px above the footprint's
// bottom, so the tail points at the pet.
const CARD_INSET_X = 18;
const CARD_BOTTOM_INSET = 24;
// The middle of Coco's visible sprite within its footprint.
const PET_CENTER_Y = 98;
// Keep a tail this far from the card's top and bottom corners.
const TAIL_CORNER_ROOM = 22;

export type AvatarBubbleSide = 'left' | 'right';

export interface AvatarCardPlacement extends Point {
  side: AvatarBubbleSide;
  /** Where the tail should point at Coco, measured from the card's top. */
  tailY: number;
}

/**
 * Screen position of a card beside Coco (its top-left corner). The card sits
 * to the left of Coco; with no room there it moves to Coco's right. Either way
 * it is kept inside the work area, sliding rather than pushing Coco when Coco
 * is parked near an edge.
 *
 * `align: 'bottom'` lines the card's bottom up with Coco's, as the bubble
 * always has. `align: 'center'` centers a tall card (the Activity panel) on
 * Coco, so Coco sits beside its middle wherever it is on screen.
 */
export function placeAvatarBubble(
  footprint: Point,
  card: Size,
  workArea: Area,
  {
    align = 'bottom',
    insetX = CARD_INSET_X,
  }: { align?: 'bottom' | 'center'; insetX?: number } = {},
): AvatarCardPlacement {
  const minX = workArea.x + BUBBLE_SCREEN_MARGIN;
  const maxX = workArea.x + workArea.width - BUBBLE_SCREEN_MARGIN - card.width;
  const minY = workArea.y + BUBBLE_SCREEN_MARGIN;
  const maxY =
    workArea.y + workArea.height - BUBBLE_SCREEN_MARGIN - card.height;
  const leftX = footprint.x + insetX - card.width;
  const rightX = footprint.x + AVATAR_FOOTPRINT - insetX;
  const side: AvatarBubbleSide =
    leftX < minX && rightX <= maxX ? 'right' : 'left';
  const x = side === 'left' ? leftX : rightX;
  const petCenterY = footprint.y + PET_CENTER_Y;
  const preferredY =
    align === 'center'
      ? petCenterY - card.height / 2
      : footprint.y + AVATAR_FOOTPRINT - CARD_BOTTOM_INSET - card.height;
  const y = Math.round(Math.max(minY, Math.min(preferredY, maxY)));
  const tailY = Math.round(
    Math.max(
      TAIL_CORNER_ROOM,
      Math.min(petCenterY - y, card.height - TAIL_CORNER_ROOM),
    ),
  );
  return { x: Math.max(minX, Math.min(x, maxX)), y, side, tailY };
}

/** Tallest card that still fits the work area with its window padding. */
export function avatarBubbleMaxHeight(workArea: Area, padding: number) {
  return Math.max(160, workArea.height - 2 * (BUBBLE_SCREEN_MARGIN + padding));
}
