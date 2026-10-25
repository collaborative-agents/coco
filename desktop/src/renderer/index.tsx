import AvatarBubbleView from './components/AvatarBubbleView';
import AvatarMenuView from './components/AvatarMenuView';
import AvatarHistoryView from './components/AvatarHistoryView';
import { createRoot } from 'react-dom/client';
import App from './App';
import type { ReactElement } from 'react';
import './global.css';
import NotificationView from './components/NotificationView';
import ImagePreviewView from './components/ImagePreviewView';
import OnboardingView from './components/OnboardingView';
import SessionSetupView from './components/SessionSetupView';
import SessionChatView from './components/SessionChatView';
import WakeWordCaptureView from './components/WakeWordCaptureView';

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);
const view = new URLSearchParams(window.location.search).get('view');

let rendered: ReactElement;
if (view === 'avatar-bubble') {
  rendered = <AvatarBubbleView />;
} else if (view === 'avatar-menu') {
  rendered = <AvatarMenuView />;
} else if (view === 'avatar-history') {
  rendered = <AvatarHistoryView />;
} else if (view === 'onboarding') {
  rendered = <OnboardingView />;
} else if (view === 'notification') {
  rendered = <NotificationView />;
} else if (view === 'session-setup') {
  rendered = <SessionSetupView />;
} else if (view === 'session') {
  rendered = <SessionChatView />;
} else if (view === 'image-preview') {
  rendered = <ImagePreviewView />;
} else if (view === 'wake-word-capture') {
  rendered = <WakeWordCaptureView />;
} else {
  rendered = <App />;
}

root.render(rendered);
