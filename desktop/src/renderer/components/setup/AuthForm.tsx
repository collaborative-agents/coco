import type { FormEvent } from 'react';

interface AuthFormProps {
  mode: 'signin' | 'signup';
  switchMode: (mode: 'signin' | 'signup') => void;
  participantId: string;
  setParticipantId: (value: string) => void;
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  confirmPassword: string;
  setConfirmPassword: (value: string) => void;
  keepSignedIn: boolean;
  setKeepSignedIn: (value: boolean) => void;
  submitting: boolean;
  error: string;
  submitLabel: string;
  submit: (event: FormEvent) => void;
}

export default function AuthForm({
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
}: AuthFormProps) {
  return (
    <>
      <div className="auth-tabs" role="tablist" aria-label="Account action">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'signin'}
          disabled={submitting}
          className={mode === 'signin' ? 'active' : ''}
          onClick={() => switchMode('signin')}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'signup'}
          disabled={submitting}
          className={mode === 'signup' ? 'active' : ''}
          onClick={() => switchMode('signup')}
        >
          Sign up
        </button>
      </div>

      <form onSubmit={submit} className="auth-form" noValidate>
        <div className="auth-field-label" id="participant-id-label">
          Username
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
          placeholder="e.g. username-001"
          required
        />
        {mode === 'signup' && (
          <>
            <div className="auth-help">
              3–64 characters: letters, numbers, periods, underscores, or
              hyphens.
            </div>
            <div className="auth-field-label" id="email-label">
              Email
            </div>
            <input
              id="email"
              aria-labelledby="email-label"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              maxLength={254}
              placeholder="you@example.com"
              required
            />
            <div className="auth-help">
              We&apos;ll only use your email to track your bootcamp progress and
              contact you if you&apos;re selected for a prize.
            </div>
          </>
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
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
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
    </>
  );
}
