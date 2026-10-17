import { FormEvent, useEffect, useState } from 'react';
import SetupShell from './setup/SetupShell';
import AuthForm from './setup/AuthForm';
import QuitConfirmation from './setup/QuitConfirmation';
import cocoIcon from '../../../assets/icon.png';
import './AuthView.css';

type AuthMode = 'signin' | 'signup';

interface AuthResult {
  success?: boolean;
  error?: string;
}

export default function AuthView() {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [participantId, setParticipantId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showQuitConfirmation, setShowQuitConfirmation] = useState(false);
  let submitLabel = mode === 'signin' ? 'Sign in' : 'Create account';
  if (submitting) submitLabel = 'Please wait…';

  useEffect(() => {
    const cleanup = window.electron.ipcRenderer.on('auth-quit-requested', () =>
      setShowQuitConfirmation(true),
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setError('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedParticipantId = participantId.trim();
    if (!normalizedParticipantId) {
      setError('Enter your username.');
      return;
    }
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(normalizedParticipantId)) {
      setError(
        'Username must be 3–64 characters and use only letters, numbers, periods, underscores, or hyphens.',
      );
      return;
    }
    const normalizedEmail = email.trim();
    if (
      mode === 'signup' &&
      (!normalizedEmail ||
        normalizedEmail.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
    ) {
      setError('Enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (mode === 'signup' && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        mode === 'signup' ? 'auth-signup' : 'auth-signin',
        {
          participantId: normalizedParticipantId,
          password,
          keepSignedIn,
          ...(mode === 'signup' ? { email: normalizedEmail } : {}),
        },
      )) as AuthResult;
      if (!result?.success) {
        setError(result?.error || 'Could not sign in. Please try again.');
        return;
      }
      window.electron.ipcRenderer.sendMessage('authentication-ui-complete');
    } catch {
      setError('Could not connect. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <SetupShell
        label=""
        title="Welcome to Coco"
        illustration={
          <img
            className="auth-welcome-icon"
            src={cocoIcon}
            alt=""
            draggable={false}
          />
        }
        description="Your proactive co-assistant for everyday work."
        closeLabel="Close Coco"
        actions={null}
        footer={null}
        onClose={() => setShowQuitConfirmation(true)}
      >
        <section className="auth-card coco-setup-panel coco-setup-panel-padded">
          <header className="auth-header">
            <h2>{mode === 'signin' ? 'Sign in' : 'Create your account'}</h2>
            <p>
              {mode === 'signin'
                ? 'Continue with your Coco account.'
                : 'Your companion is almost ready.'}
            </p>
          </header>
          <AuthForm
            {...{
              mode,
              switchMode,
              participantId,
              setParticipantId,
              email,
              setEmail,
              password,
              setPassword,
              confirmPassword,
              setConfirmPassword,
              keepSignedIn,
              setKeepSignedIn,
              submitting,
              error,
              submitLabel,
              submit,
            }}
          />
        </section>
      </SetupShell>
      {showQuitConfirmation && (
        <QuitConfirmation onCancel={() => setShowQuitConfirmation(false)} />
      )}
    </>
  );
}
