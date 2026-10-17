import { useRef, type ReactNode } from 'react';
import cocoIcon from '../../../../assets/icon.png';
import WorkspaceIcon from './WorkspaceIcon';
import WindowControls from './WindowControls';
import './DesktopWorkspace.css';

interface Props {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  active: 'chat' | 'personalization' | 'settings';
  historyOpen: boolean;
  onHistoryOpen: () => void;
  onHistoryClose: () => void;
  onNavigate: (page: 'chat' | 'personalization' | 'settings') => void;
  history: ReactNode;
  children: ReactNode;
  details: ReactNode;
}

export default function DesktopWorkspace({
  expanded,
  onExpandedChange,
  active,
  historyOpen,
  onHistoryOpen,
  onHistoryClose,
  onNavigate,
  history,
  children,
  details,
}: Props) {
  const chatButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      className={`desktop-workspace ${expanded ? 'is-expanded' : 'is-collapsed'}`}
    >
      <div
        className="workspace-navigation"
        role="presentation"
        onMouseLeave={onHistoryClose}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            onHistoryClose();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            chatButtonRef.current?.focus();
            onHistoryClose();
            event.stopPropagation();
          }
        }}
      >
        <nav className="workspace-rail" aria-label="Main navigation">
          <div className="workspace-logo">
            <img src={cocoIcon} alt="Coco" />
          </div>
          <div className="workspace-rail-pages">
            <button
              ref={chatButtonRef}
              type="button"
              title="Chat"
              aria-label="Chat"
              aria-current={active === 'chat' ? 'page' : undefined}
              aria-expanded={historyOpen}
              aria-controls="conversation-sidebar"
              onMouseEnter={onHistoryOpen}
              onFocus={onHistoryOpen}
              onClick={() => onNavigate('chat')}
            >
              <WorkspaceIcon name="chat" />
            </button>
            <button
              type="button"
              title="Personalization"
              aria-label="Personalization"
              aria-current={active === 'personalization' ? 'page' : undefined}
              onMouseEnter={onHistoryClose}
              onClick={() => onNavigate('personalization')}
            >
              <WorkspaceIcon name="personalization" />
            </button>
          </div>
          <button
            type="button"
            className="workspace-settings-button"
            title="Settings"
            aria-label="Settings"
            aria-current={active === 'settings' ? 'page' : undefined}
            onMouseEnter={onHistoryClose}
            onClick={() => onNavigate('settings')}
          >
            <WorkspaceIcon name="settings" />
          </button>
        </nav>
        {historyOpen && history}
      </div>
      <section
        className="workspace-chat"
        aria-label="Chat"
        hidden={active !== 'chat'}
      >
        {children}
      </section>
      <section
        className="workspace-details"
        aria-label={
          active === 'settings' ? 'Settings panel' : 'Personalization panel'
        }
        hidden={active === 'chat'}
      >
        <header className="workspace-page-header">
          <span>Coco</span>
          <div className="workspace-window-controls">
            <WindowControls
              expanded={expanded}
              onExpandedChange={onExpandedChange}
            />
          </div>
        </header>
        <div className="workspace-page-content">{details}</div>
      </section>
    </div>
  );
}
