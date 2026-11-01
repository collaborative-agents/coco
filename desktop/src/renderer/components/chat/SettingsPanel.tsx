import { useRef, useState, type ReactNode } from 'react';
import './Settings.css';

const categories = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'memory', label: 'Memory' },
  { id: 'usage', label: 'Usage' },
  { id: 'health', label: 'Health' },
] as const;
type Category = (typeof categories)[number]['id'];

export default function SettingsPanel({
  sections,
}: {
  sections: Record<Category, ReactNode>;
}) {
  const [active, setActive] = useState<Category>('general');
  const content = useRef<HTMLDivElement>(null);
  return (
    <div className="workspace-settings">
      <h1>Settings</h1>
      <nav className="settings-navigation" aria-label="Settings categories">
        {categories.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-current={active === id ? 'page' : undefined}
            aria-controls={`settings-page-${id}`}
            onClick={() => {
              setActive(id);
              if (content.current) content.current.scrollTop = 0;
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-content" ref={content}>
        {categories.map(({ id, label }) => (
          <div
            key={id}
            id={`settings-page-${id}`}
            className="settings-category"
            role="region"
            aria-label={`${label} settings`}
            hidden={active !== id}
          >
            {sections[id]}
          </div>
        ))}
      </div>
    </div>
  );
}
