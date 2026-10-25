import type { ReactNode } from 'react';
import './SetupShell.css';

interface SetupShellProps {
  label: string;
  title: string;
  description: string;
  illustration: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  closeLabel: string;
}

export default function SetupShell({
  label,
  title,
  description,
  illustration,
  children,
  actions,
  footer,
  onClose,
  closeLabel,
}: SetupShellProps) {
  return (
    <main className="coco-setup-shell">
      <header className="coco-setup-header">
        <span className="coco-setup-brand">
          <span /> Coco
        </span>
        <button
          type="button"
          className="coco-setup-close"
          aria-label={closeLabel}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="coco-setup-layout">
        <section
          className="coco-setup-intro"
          aria-labelledby="coco-setup-title"
        >
          {label && <p className="coco-setup-eyebrow">{label}</p>}
          <div className="coco-setup-title-row">
            <h1 id="coco-setup-title" tabIndex={-1}>
              {title}
            </h1>
            {illustration}
          </div>
          <p className="coco-setup-description">{description}</p>
          {actions && <div className="coco-setup-actions">{actions}</div>}
        </section>
        <section className="coco-setup-content" aria-label={title}>
          {children}
        </section>
      </div>
      {footer && <footer className="coco-setup-footer">{footer}</footer>}
    </main>
  );
}
