import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import '../App.css';
import './AvatarHistoryView.css';
import ActivityPanel from './ActivityPanel';
import type { ActivityRecord, InstantSuggestion } from './observation-types';

const ipc = () => window.electron?.ipcRenderer;

const setPointerInside = (inside: boolean) =>
  ipc()?.sendMessage('avatar-history-pointer', { inside });

// Refetching on every change would reread the history file for each burst of
// writes (an observation and its support are recorded moments apart).
const REFRESH_DELAY_MS = 300;

/**
 * Coco's Activity panel, rendered in its own window beside the avatar. It
 * reads the persisted history when opened and rereads it whenever main
 * reports a change, so it always matches what is on disk. Main sizes and
 * places the window from the panel size reported here, and reveals it once
 * the opened panel has been painted.
 */
export default function AvatarHistoryView() {
  const [open, setOpen] = useState(false);
  // Remounts the panel on every opening so it starts on today, collapsed.
  const [openCount, setOpenCount] = useState(0);
  // Newest first; the history file is chronological.
  const [records, setRecords] = useState<ActivityRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Which side of Coco the panel is on, and where its tail points at Coco.
  const [placement, setPlacement] = useState<{
    side: 'left' | 'right';
    tailY: number;
  } | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    try {
      const rows = await ipc()?.invoke('get-activity-history');
      if (Array.isArray(rows)) {
        setRecords((rows as ActivityRecord[]).slice().reverse());
      }
    } catch {
      // Keep showing what was last read.
    }
    setLoaded(true);
  };

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const removeOpen = ipc()?.on('avatar-history-open', () => {
      setOpen(true);
      setOpenCount((count) => count + 1);
      setLoaded(false);
      refresh();
    });
    const removeClosed = ipc()?.on('avatar-history-closed', () => {
      setOpen(false);
      setPointerInside(false);
    });
    const removePlacement = ipc()?.on(
      'avatar-history-placement',
      (value: unknown) => {
        const data = value as { side?: string; tailY?: number } | undefined;
        if (typeof data?.tailY !== 'number') return;
        setPlacement({
          side: data.side === 'right' ? 'right' : 'left',
          tailY: data.tailY,
        });
      },
    );
    const removeChanged = ipc()?.on('activity-history-changed', () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh();
      }, REFRESH_DELAY_MS);
    });
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (typeof removeOpen === 'function') removeOpen();
      if (typeof removeClosed === 'function') removeClosed();
      if (typeof removeChanged === 'function') removeChanged();
      if (typeof removePlacement === 'function') removePlacement();
    };
  }, []);

  const shown = open && loaded;

  // Report the panel's layout box whenever its content changes size.
  useLayoutEffect(() => {
    const panel = shown
      ? viewRef.current?.querySelector<HTMLElement>('.obs-history-panel')
      : null;
    if (!panel) return undefined;
    const report = () =>
      ipc()?.sendMessage('avatar-history-size', {
        width: panel.offsetWidth,
        height: panel.offsetHeight,
      });
    report();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(report);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [shown, openCount]);

  // Two animation frames: the first runs before the new layout is painted,
  // the second after it.
  useEffect(() => {
    if (!shown) return undefined;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() =>
        ipc()?.sendMessage('avatar-history-painted'),
      );
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [shown, openCount]);

  const loadSuggestion = async (
    record: ActivityRecord,
  ): Promise<InstantSuggestion | null> => {
    let res;
    try {
      res = await ipc()?.invoke('get-instant-suggestion', {
        observationId: record.observation_id ?? null,
      });
    } catch {
      return null;
    }
    const suggestion = res?.status === 'ready' ? res.suggestion : null;
    if (!suggestion) return null;
    setRecords((prev) =>
      prev.map((item) =>
        item.observation_id === record.observation_id
          ? {
              ...item,
              proactive_support: {
                engaged: item.proactive_support?.engaged ?? false,
                ...item.proactive_support,
                suggestion,
                available: true,
              },
            }
          : item,
      ),
    );
    return suggestion;
  };

  const rateSupport = (record: ActivityRecord, rating: 'up' | 'down') => {
    const previousRating = record.proactive_support?.rating;
    if (!record.observation_id || previousRating === rating) return;
    const ratedAt = Math.floor(Date.now() / 1000);
    setRecords((prev) =>
      prev.map((item) =>
        item.observation_id === record.observation_id
          ? {
              ...item,
              proactive_support: {
                engaged: item.proactive_support?.engaged ?? false,
                ...item.proactive_support,
                rating,
                rated_at: ratedAt,
              },
            }
          : item,
      ),
    );
    ipc()?.sendMessage('training-feedback', {
      kind: rating === 'up' ? 'thumbs_up' : 'thumbs_down',
      previous_kind: previousRating ? `thumbs_${previousRating}` : null,
      surface: 'history',
      observation_id: record.observation_id,
      status: record.status,
      text:
        record.proactive_support?.suggestion?.copyText ?? record.observation,
    });
    ipc()?.sendMessage('activity-support-rated', {
      observationId: record.observation_id,
      rating,
      ratedAt,
    });
  };

  return (
    <div ref={viewRef} className="avatar-history-view">
      {shown && (
        <div
          key={openCount}
          className="avatar-history-card"
          onMouseEnter={() => setPointerInside(true)}
          onMouseLeave={() => setPointerInside(false)}
        >
          <ActivityPanel
            records={records}
            onClose={() => ipc()?.sendMessage('avatar-history-close')}
            onViewConversation={() => ipc()?.sendMessage('open-main-window')}
            onLoadSuggestion={loadSuggestion}
            onRateSupport={rateSupport}
          />
          {placement && (
            <span
              className={`avatar-history-tail is-${placement.side}`}
              style={{ top: placement.tailY - 6 }}
              aria-hidden
            />
          )}
        </div>
      )}
    </div>
  );
}
