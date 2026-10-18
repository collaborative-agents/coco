/** Subscribe before reading, so a delayed initial reply cannot undo a wake event. */
export default function subscribeCocoSleepMode(
  onChange: (sleeping: boolean) => void,
) {
  let disposed = false;
  let revision = 0;
  const ipc = window.electron?.ipcRenderer;
  const remove = ipc?.on('coco-sleep-mode-changed', (value: unknown) => {
    revision += 1;
    if (!disposed)
      onChange((value as { sleeping?: boolean })?.sleeping === true);
  });
  const refresh = async () => {
    const startedAtRevision = revision;
    try {
      const state = (await ipc?.invoke('get-coco-sleep-mode')) as
        | { sleeping?: boolean }
        | undefined;
      if (
        !disposed &&
        revision === startedAtRevision &&
        typeof state?.sleeping === 'boolean'
      ) {
        revision += 1;
        onChange(state.sleeping);
      }
    } catch {
      // Keep the last known state; the next refresh can recover a missed event.
    }
  };
  refresh();
  // This lightweight state read continues while asleep; it does not probe models.
  const interval = window.setInterval(refresh, 30000);
  return () => {
    disposed = true;
    window.clearInterval(interval);
    if (typeof remove === 'function') remove();
  };
}
