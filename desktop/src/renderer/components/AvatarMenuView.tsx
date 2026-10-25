import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './AvatarMenuView.css';
import PetMenuIcon from './PetMenuIcon';
import subscribeCocoSleepMode from '../services/coco-sleep-mode';
import { COCO_NAVIGATION } from '../../shared/coco-navigation';

/** Actions the avatar renderer runs when a menu item is chosen. */
export type AvatarMenuAction =
  | (typeof COCO_NAVIGATION)[number]['channel']
  | 'toggle-sleep'
  | 'quit';

const runAction = (action: AvatarMenuAction) =>
  window.electron?.ipcRenderer.sendMessage('avatar-menu-action', action);

/**
 * Coco's ••• menu, rendered in its own window. Main sizes and places the
 * window while it is invisible and reveals it once this view reports that the
 * menu has been painted, so opening never flashes a stale or clipped frame.
 */
export default function AvatarMenuView() {
  const [open, setOpen] = useState(false);
  // Remounts the menu on every opening so its entry animation replays.
  const [openCount, setOpenCount] = useState(0);
  const [below, setBelow] = useState(false);
  const [cocoSleeping, setCocoSleeping] = useState(false);
  const [hidingAvatar, setHidingAvatar] = useState(false);
  const [hideError, setHideError] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => subscribeCocoSleepMode(setCocoSleeping), []);

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    const removeOpen = ipc?.on('avatar-menu-open', (value: unknown) => {
      setBelow((value as { below?: boolean } | undefined)?.below === true);
      setHideError('');
      setOpen(true);
      setOpenCount((count) => count + 1);
    });
    const removeClosed = ipc?.on('avatar-menu-closed', () => setOpen(false));
    return () => {
      if (typeof removeOpen === 'function') removeOpen();
      if (typeof removeClosed === 'function') removeClosed();
    };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape')
        window.electron?.ipcRenderer.sendMessage('close-avatar-menu');
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  // Two animation frames: the first runs before the new layout is painted,
  // the second after it.
  useEffect(() => {
    if (!open) return undefined;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() =>
        window.electron?.ipcRenderer.sendMessage('avatar-menu-painted'),
      );
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [open, openCount]);

  // Main sizes the window from the menu's layout box (unaffected by the entry
  // animation's transform). Re-report whenever the content can change height.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    window.electron?.ipcRenderer.sendMessage('avatar-menu-size', {
      width: menu.offsetWidth,
      height: menu.offsetHeight,
    });
  }, [openCount, hideError, hidingAvatar, cocoSleeping]);

  return (
    // The transparent padding around the menu (room for its shadow) overlaps
    // Coco's ••• button and still catches clicks, so treat a click there as a
    // click outside the menu.
    <div
      className="avatar-menu-view"
      onPointerDown={(event) => {
        if (open && !menuRef.current?.contains(event.target as Node))
          window.electron?.ipcRenderer.sendMessage('close-avatar-menu');
      }}
    >
      <div
        key={openCount}
        ref={menuRef}
        className={`pet-actions-menu${below ? ' is-below' : ''}${
          open ? '' : ' is-closed'
        }`}
        role="menu"
        aria-label="Coco actions"
        aria-hidden={!open}
      >
        {COCO_NAVIGATION.map(({ label, channel, icon }) => (
          <button
            type="button"
            role="menuitem"
            key={channel}
            onClick={() => runAction(channel)}
          >
            <PetMenuIcon name={icon} />
            <span>{label}</span>
          </button>
        ))}
        <div className="pet-actions-divider" role="separator" />
        <button
          type="button"
          role="menuitem"
          disabled={hidingAvatar}
          onClick={async () => {
            setHideError('');
            setHidingAvatar(true);
            try {
              const result = (await window.electron?.ipcRenderer.invoke(
                'update-avatar-visibility',
                { hideAvatar: true },
              )) as { success?: boolean } | undefined;
              if (!result?.success)
                throw new Error('Could not hide Coco. Please try again.');
              window.electron?.ipcRenderer.sendMessage('close-avatar-menu');
            } catch {
              setHideError('Could not hide Coco. Please try again.');
            } finally {
              setHidingAvatar(false);
            }
          }}
        >
          <PetMenuIcon name="hide" />
          <span>{hidingAvatar ? 'Hiding…' : 'Hide'}</span>
        </button>
        {hideError && (
          <div
            role="alert"
            style={{
              padding: '4px 10px',
              fontSize: 'var(--coco-text-secondary)',
            }}
          >
            {hideError}
          </div>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={() => runAction('toggle-sleep')}
        >
          <PetMenuIcon name={cocoSleeping ? 'wake' : 'sleep'} />
          <span>{cocoSleeping ? 'Wake Coco' : 'Sleep'}</span>
        </button>
        <div className="pet-actions-divider" role="separator" />
        <button type="button" role="menuitem" onClick={() => runAction('quit')}>
          <PetMenuIcon name="quit" />
          <span>Quit</span>
        </button>
      </div>
    </div>
  );
}
