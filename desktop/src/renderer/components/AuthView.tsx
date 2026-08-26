import { FormEvent, useState } from 'react';
import './AuthView.css';

type AuthMode = 'signin' | 'signup';

interface AuthResult {
  success?: boolean;
  error?: string;
}

export default function AuthView() {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [participantId, setParticipantId] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setPassword('');
    setConfirmPassword('');
    setError('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedParticipantId = participantId.trim();
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(normalizedParticipantId)) {
      setError(
        'Participant ID must be 3–64 characters and use only letters, numbers, periods, underscores, or hyphens.',
      );
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
    const result = (await window.electron.ipcRenderer.invoke(
      mode === 'signup' ? 'auth-signup' : 'auth-signin',
      {
        participantId: normalizedParticipantId,
        password,
        keepSignedIn,
      },
    )) as AuthResult;
    setSubmitting(false);
    if (!result?.success) {
      setError(result?.error || 'Could not sign in. Please try again.');
      return;
    }
    window.electron.ipcRenderer.sendMessage('authentication-ui-complete');
  };

  let submitLabel = 'Create account';
  if (submitting) submitLabel = 'Please wait…';
  else if (mode === 'signin') submitLabel = 'Sign in';

  return (
    <main className="auth-root">
      <section className="auth-card">
        <header className="auth-header">
          <div className="auth-brand">
            <span className="auth-brand-dot" />
            <span>Coco study</span>
          </div>
          <h1>{mode === 'signin' ? 'Welcome back' : 'Create your account'}</h1>
          <p>Sign in with the participant ID assigned for this study.</p>
        </header>

        <div className="auth-tabs" role="tablist" aria-label="Account action">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signin'}
            className={mode === 'signin' ? 'active' : ''}
            onClick={() => switchMode('signin')}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => switchMode('signup')}
          >
            Sign up
          </button>
        </div>

        <form onSubmit={submit} className="auth-form" noValidate>
          <label htmlFor="participant-id">
            Participant ID
            <input
              id="participant-id"
              value={participantId}
              onChange={(event) => setParticipantId(event.target.value)}
              autoComplete="username"
              maxLength={64}
              required
            />
          </label>

          <label htmlFor="password">
            Password
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={
                mode === 'signin' ? 'current-password' : 'new-password'
              }
              maxLength={256}
              required
            />
          </label>

          {mode === 'signup' && (
            <label htmlFor="confirm-password">
              Confirm password
              <input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                maxLength={256}
                required
              />
            </label>
          )}

          <label className="auth-checkbox" htmlFor="keep-signed-in">
            <input
              id="keep-signed-in"
              type="checkbox"
              checked={keepSignedIn}
              onChange={(event) => setKeepSignedIn(event.target.checked)}
            />
            <span>
              <strong>Keep me signed in</strong>
              <small>Recommended on your personal computer</small>
            </span>
          </label>

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          <button className="auth-submit" type="submit" disabled={submitting}>
            {submitLabel}
          </button>
        </form>
      </section>
    </main>
  );
}
