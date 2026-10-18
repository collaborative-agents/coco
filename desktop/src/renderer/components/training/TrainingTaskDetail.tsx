import { useEffect, useState } from 'react';
import type { TrainingDay } from '../../../shared/study';
import type { TrainingMaterials } from '../../../shared/training-materials';
import TrainingDocumentView from './TrainingDocumentView';
import TrainingSubmissionView from './TrainingSubmissionView';
import { api, format } from './training-api';

export default function TrainingTaskDetail({
  day,
  busy,
  onReflect,
}: {
  day: TrainingDay;
  busy: boolean;
  onReflect: () => void;
}) {
  const [materials, setMaterials] = useState<TrainingMaterials | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    setMaterials(null);
    setError('');
    setNotice('');
    api('study-task-materials', day.day)
      .then((data: TrainingMaterials) => {
        if (!active) return undefined;
        if (
          !data ||
          !Array.isArray(data.documents) ||
          !Array.isArray(data.files)
        )
          throw new Error('Task instructions could not be loaded.');
        setMaterials(data);
        return undefined;
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [day.day, retry]);
  const document = materials?.documents[0];
  const references =
    materials?.files.filter((file) => file.id !== document?.id) ?? [];
  const saveReferences = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = (await api('study-save-references', day.day)) as {
        success?: boolean;
      };
      if (result.success) setNotice('Reference files saved.');
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const referenceDownload =
    references.length > 0 ? (
      <button
        className="training-reference-download"
        type="button"
        disabled={saving}
        onClick={saveReferences}
      >
        {saving ? 'Saving…' : 'Download all reference files'}
      </button>
    ) : null;
  return (
    <>
      <p className="training-detail-meta">
        Day {day.day}
        {day.completed_at ? ` · Completed ${format(day.completed_at)}` : ''}
      </p>
      {error && (
        <div role="alert" className="training-error">
          {error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </div>
      )}
      {!materials && !error && <p role="status">Loading task instructions…</p>}
      {materials && (
        <>
          {document ? (
            <TrainingDocumentView
              document={document}
              referenceDownload={referenceDownload}
            />
          ) : (
            <p>
              No previewable instructions were found. Ask your organizer to
              include a PDF, Markdown, or text instruction file.
            </p>
          )}
          {!document && referenceDownload}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {day.completed_at ? (
        <TrainingSubmissionView day={day.day} />
      ) : (
        <footer className="training-detail-footer">
          <button
            className="training-primary"
            type="button"
            disabled={busy || saving}
            onClick={onReflect}
          >
            Mark as finish
          </button>
        </footer>
      )}
    </>
  );
}
