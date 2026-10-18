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
