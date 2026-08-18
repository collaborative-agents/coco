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
  let submitLabel = mode === 'signin' ? 'Sign in' : 'Create account';
  if (submitting) submitLabel = 'Please wait…';

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setPassword('');
    setConfirmPassword('');
    setError('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedParticipantId = participantId.trim();
    if (!normalizedParticipantId) {
      setError('Enter your Participant ID.');
      return;
    }
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
      { participantId: normalizedParticipantId, password, keepSignedIn },
    )) as AuthResult;
    setSubmitting(false);
    if (!result?.success) {
      setError(result?.error || 'Could not sign in. Please try again.');
      return;
    }
    window.electron.ipcRenderer.sendMessage('authentication-ui-complete');
  };

  return (
    <main className="auth-root">
      <section className="auth-card">
        <header className="auth-header">
          <div className="auth-brand">
            <span className="auth-brand-dot" />
            <span>CoCo</span>
          </div>
          <h1>{mode === 'signin' ? 'Welcome back' : 'Create your account'}</h1>
          <p>
            {mode === 'signin'
              ? 'Sign in to continue your learning sessions.'
              : 'Your new account will begin with a short onboarding.'}
          </p>
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
          <div className="auth-field-label" id="participant-id-label">
            Participant ID
          </div>
          <input
            id="participant-id"
            aria-labelledby="participant-id-label"
            value={participantId}
            onChange={(event) => setParticipantId(event.target.value)}
            autoComplete="username"
            minLength={3}
            maxLength={64}
            pattern="[A-Za-z0-9._-]+"
            placeholder="e.g. participant-001"
            required
          />
          {mode === 'signup' && (
            <div className="auth-help">
              3–64 characters: letters, numbers, periods, underscores, or
              hyphens.
            </div>
          )}

          <div className="auth-field-label" id="password-label">
            Password
          </div>
          <input
            id="password"
            aria-labelledby="password-label"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={
              mode === 'signin' ? 'current-password' : 'new-password'
            }
            minLength={8}
            maxLength={256}
            required
          />

          {mode === 'signup' && (
            <>
              <div className="auth-field-label" id="confirm-password-label">
                Confirm password
              </div>
              <input
                id="confirm-password"
                aria-labelledby="confirm-password-label"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                maxLength={256}
                required
              />
            </>
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
