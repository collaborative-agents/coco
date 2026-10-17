export type WorkspaceIconName =
  | 'chat'
  | 'personalization'
  | 'settings'
  | 'new'
  | 'expand'
  | 'collapse'
  | 'close';

export default function WorkspaceIcon({ name }: { name: WorkspaceIconName }) {
  const paths = {
    chat: (
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z" />
    ),
    personalization: (
      <>
        <circle cx="10" cy="7" r="4" />
        <path d="M3 21v-2a7 7 0 0 1 10-6.3M18 12l1.4 3.6L23 17l-3.6 1.4L18 22l-1.4-3.6L13 17l3.6-1.4Z" />
      </>
    ),
    settings: <path d="M4 8h16M4 16h16" />,
    new: <path d="M12 5v14M5 12h14" />,
    expand: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M13 4v16m3-11 2 3-2 3" />
      </>
    ),
    collapse: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M13 4v16m5-11-2 3 2 3" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return (
    <svg
      data-header-icon={name}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
