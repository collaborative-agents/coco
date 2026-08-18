import { createRoot } from 'react-dom/client';
import App from './App';
import NotificationView from './components/NotificationView';
import OnboardingView from './components/OnboardingView';
import SessionSetupView from './components/SessionSetupView';
import SessionChatView from './components/SessionChatView';
import SessionRecapView from './components/SessionRecapView';
import AuthView from './components/AuthView';

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);
const view = new URLSearchParams(window.location.search).get('view');

let rendered: JSX.Element;
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
} else if (view === 'session-recap') {
  rendered = <SessionRecapView />;
} else {
  rendered = <App />;
}

root.render(rendered);

// calling IPC exposed from preload script
window.electron?.ipcRenderer.once('ipc-example', (arg) => {
  // eslint-disable-next-line no-console
  console.log(arg);
});
window.electron?.ipcRenderer.sendMessage('ipc-example', ['ping']);
