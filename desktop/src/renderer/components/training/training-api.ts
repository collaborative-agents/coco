export const api = (
  channel: Parameters<typeof window.electron.ipcRenderer.invoke>[0],
  ...args: unknown[]
) => window.electron.ipcRenderer.invoke(channel, ...args);

export const format = (value: string | null) =>
  value ? new Date(value).toLocaleString('en-US') : '—';
