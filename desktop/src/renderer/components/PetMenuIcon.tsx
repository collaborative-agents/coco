import WorkspaceIcon from './chat/WorkspaceIcon';

export default function PetMenuIcon({
  name,
}: {
  name: 'chat' | 'sleep' | 'wake' | 'quit' | 'settings' | 'hide';
}) {
  if (name === 'chat') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M4 5.5h16v11H9l-5 4v-15Z" />
      </svg>
    );
  }
  if (name === 'hide') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M3 3l18 18M10.5 5.2c5.3-.8 9 4.2 10.5 6.8a19 19 0 0 1-3 3.8M6.1 6.1A20 20 0 0 0 3 12c2.5 4 5.5 7 9 7a10 10 0 0 0 4-1M10 10a3 3 0 0 0 4 4" />
      </svg>
    );
  }
  if (name === 'sleep') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M20 15.2A8.6 8.6 0 0 1 8.8 4a8.7 8.7 0 1 0 11.2 11.2Z" />
      </svg>
    );
  }
  if (name === 'wake') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
      </svg>
    );
  }
  if (name === 'quit') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12 3v9M7 5.5a8 8 0 1 0 10 0" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M9.6 3.2h4.8l.6 2.2 1.5.9 2.2-.6 2.4 4.1-1.6 1.6v1.7l1.6 1.6-2.4 4.1-2.2-.6-1.5.9-.6 2.2H9.6L9 19.1l-1.5-.9-2.2.6-2.4-4.1 1.6-1.6v-1.7L2.9 9.8l2.4-4.1 2.2.6L9 5.4l.6-2.2Z" />
      <circle cx="12" cy="12.2" r="3" />
    </svg>
  );
}
