import { createRoot } from 'react-dom/client';
import type { ReactElement } from 'react';
import './global.css';
import App from './App';
import NotificationView from './components/NotificationView';
import ImagePreviewView from './components/ImagePreviewView';
import OnboardingView from './components/OnboardingView';
import SessionSetupView from './components/SessionSetupView';
import SessionChatView from './components/SessionChatView';
import WakeWordCaptureView from './components/WakeWordCaptureView';
import AuthView from './components/AuthView';

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);
const view = new URLSearchParams(window.location.search).get('view');

let rendered: ReactElement;
if (view === 'auth') {
  rendered = <AuthView />;
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
