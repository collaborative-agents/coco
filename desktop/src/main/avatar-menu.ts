import type { MenuItemConstructorOptions } from 'electron';
import { COCO_NAVIGATION } from '../shared/coco-navigation';

export function cocoNavigationItems(
  actions: Record<(typeof COCO_NAVIGATION)[number]['channel'], () => void>,
): MenuItemConstructorOptions[] {
  return COCO_NAVIGATION.map(({ label, channel }) => ({
    label,
    click: actions[channel],
  }));
}

export function avatarRecoveryItems(
  hidden: boolean,
  showAvatar: () => void,
): MenuItemConstructorOptions[] {
  return hidden ? [{ label: 'Show Coco', click: showAvatar }] : [];
}

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type Area = Point & Size;

const AVATAR_FOOTPRINT = 180;
const MENU_SCREEN_MARGIN = 4;

/**
 * Screen position of the ••• menu's top-left corner. It keeps the spot it had
 * when it lived inside the avatar window: right edge 32px inside Coco's 180px
 * footprint and bottom edge 25px below its top, just above the pet. With no
 * room above, the menu drops down over Coco from just under the ••• trigger.
 * Either way it is kept inside the work area.
 */
export function placeAvatarMenu(
  footprint: Point,
  menu: Size,
  workArea: Area,
): Point & { below: boolean } {
  const minY = workArea.y + MENU_SCREEN_MARGIN;
  const maxY = workArea.y + workArea.height - MENU_SCREEN_MARGIN - menu.height;
  const minX = workArea.x + MENU_SCREEN_MARGIN;
  const maxX = workArea.x + workArea.width - MENU_SCREEN_MARGIN - menu.width;
  const above = footprint.y + 25 - menu.height;
  const below = above < minY;
  const y = below ? footprint.y + 56 : above;
  const x = footprint.x + AVATAR_FOOTPRINT - 32 - menu.width;
  return {
    x: Math.max(minX, Math.min(x, maxX)),
    y: Math.max(minY, Math.min(y, maxY)),
    below,
  };
}
