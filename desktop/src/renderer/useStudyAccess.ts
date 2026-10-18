import { useEffect, useState } from 'react';

/** Unknown/unreachable policy never enables tutor controls. */
export default function useStudyAccess() {
  const [allowed, setAllowed] = useState<boolean | null | 'unavailable'>(null);
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const value = (await window.electron.ipcRenderer.invoke(
          'study-access',
        )) as { tutoring_allowed?: boolean; status?: string };
        if (mounted) {
          if (value?.tutoring_allowed === true) setAllowed(true);
          else if (
            value?.status === 'disabled' ||
            value?.status === 'preassessment'
          )
            setAllowed(false);
          else if (value?.status === 'checking') setAllowed(null);
          else setAllowed('unavailable');
        }
      } catch {
        if (mounted) setAllowed('unavailable');
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  return allowed;
}
