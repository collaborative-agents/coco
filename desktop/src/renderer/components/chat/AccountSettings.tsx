import { useCallback, useEffect, useState } from 'react';
import { S } from './styles';
import './Settings.css';

type Profile = Record<string, unknown> & {
  participantId?: string;
  userName?: string;
};

export default function AccountSettings() {
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const profile = (await window.electron.ipcRenderer.invoke(
        'get-profile',
      )) as Profile | null;
      if (!profile?.participantId)
        throw new Error('Could not load your account.');
      setUsername(profile.participantId);
      setName(profile.userName ?? '');
      setSavedName(profile.userName ?? '');
      setLoaded(true);
    } catch {
      setError('Could not load your account. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!loaded || saving || !name.trim()) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      // Re-read before saving so other preferences changed since opening
      // Settings (such as avatar visibility) are not overwritten.
      const profile = (await window.electron.ipcRenderer.invoke(
        'get-profile',
      )) as Profile | null;
      if (!profile || profile.participantId !== username) {
        throw new Error(
          'Your account has changed. Reopen Settings to continue.',
        );
      }
      const result = (await window.electron.ipcRenderer.invoke('save-profile', {
        ...profile,
        userName: name.trim(),
      })) as { success?: boolean; error?: string } | undefined;
      if (!result?.success)
        throw new Error(result?.error || 'Could not save your name.');
      setName(name.trim());
      setSavedName(name.trim());
      setSaved(true);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not save your name.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="workspace-settings-section"
      aria-labelledby="account-heading"
    >
      <h2 id="account-heading" className="settings-heading">
        Account
      </h2>
      {loading ? (
        <p role="status">Loading account…</p>
      ) : (
        loaded && (
          <form
            className="settings-account-form"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="settings-account-identity">
              <span>Username</span>
              <strong>{username}</strong>
            </div>
            <label htmlFor="coco-preferred-name">
              What should Coco call you?
              <input
                id="coco-preferred-name"
                autoComplete="given-name"
                style={S.customInput}
                value={name}
                disabled={saving}
                required
                onChange={(event) => {
                  setName(event.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <div style={S.saveRow}>
              <button
                type="submit"
                style={S.saveBtn}
                disabled={saving || !name.trim() || name.trim() === savedName}
              >
                {saving ? 'Saving…' : 'Save name'}
              </button>
            </div>
            {saved && (
              <span role="status" style={S.saved}>
                Name saved for new conversations.
              </span>
            )}
          </form>
        )
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {!loading && !loaded && (
        <button type="button" style={S.addBtn} onClick={load}>
          Try again
        </button>
      )}
    </section>
  );
}
