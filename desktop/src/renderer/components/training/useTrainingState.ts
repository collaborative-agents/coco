import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudyState } from '../../../shared/study';
import { api } from './training-api';

/** Fetch only while Training is open; keep loaded data and drafts across tabs. */
export default function useTrainingState(visible: boolean, refreshKey: number) {
  const [state, setState] = useState<StudyState | null>(null);
  const [studentMode, setStudentMode] = useState(false);
  const [error, setError] = useState('');
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    requestVersion.current += 1;
    const version = requestVersion.current;
    try {
      const [data, mode] = (await Promise.all([
        api('study-me'),
        api('study-student-mode'),
      ])) as [StudyState, { enabled?: boolean }];
      if (version !== requestVersion.current) return;
      setState(data);
      setStudentMode(mode?.enabled === true);
      setError('');
    } catch (reason) {
      // A response from a previous visit must not overwrite a newer result.
      if (version !== requestVersion.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    setError('');
    const update = () => {
      refresh().catch(() => undefined);
    };
    update();
    const timer = setInterval(update, 30000);
    return () => {
      clearInterval(timer);
      requestVersion.current += 1;
    };
  }, [visible, refreshKey, refresh]);

  return { state, studentMode, error, setError, refresh };
}
