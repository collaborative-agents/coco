import { useEffect, useRef, useState } from 'react';

export interface ProvisionalPreference {
  id: string;
  section: string;
  content: string;
  helpful: number;
  harmful: number;
  updatedAt?: number;
}

interface DiscoveryOptions {
  active?: boolean;
  visibleMs?: number;
  expandedVisibleMs?: number;
  cooldownMs?: number;
}

function preferenceVersion(preference: ProvisionalPreference): string {
  return [preference.id, preference.updatedAt ?? '', preference.content].join(
    '\u0000',
  );
}

function newestPreference(
  preferences: readonly ProvisionalPreference[],
): ProvisionalPreference | undefined {
  const timestamped = preferences.filter(
    (preference) => preference.updatedAt !== undefined,
  );
  if (timestamped.length === 0) return preferences.at(-1);
  return timestamped.reduce((newest, preference) =>
    preference.updatedAt! > newest.updatedAt! ? preference : newest,
  );
}

function inDiscoveryOrder(
  preferences: ProvisionalPreference[],
): ProvisionalPreference[] {
  return preferences.sort((left, right) => {
    if (left.updatedAt === undefined || right.updatedAt === undefined) return 0;
    return left.updatedAt - right.updatedAt;
  });
}

/**
 * Turns polling snapshots into short-lived, sequential discovery notices.
 * Existing preferences produce one current notice when the panel opens; later
 * additions and revisions are queued so each gets a complete visible period.
 */
export default function useProvisionalDiscovery(
  preferences: readonly ProvisionalPreference[] | undefined,
  options: DiscoveryOptions = {},
) {
  const active = options.active ?? true;
  const visibleMs = options.visibleMs ?? 6000;
  const expandedVisibleMs = options.expandedVisibleMs ?? 10000;
  const cooldownMs = options.cooldownMs ?? 1200;
  const initialized = useRef(false);
  const seenVersions = useRef(new Set<string>());
  const [pending, setPending] = useState<ProvisionalPreference[]>([]);
  const [visiblePreference, setVisiblePreference] =
    useState<ProvisionalPreference | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [coolingDown, setCoolingDown] = useState(false);

  useEffect(() => {
    if (!active || !preferences) return;

    if (!initialized.current) {
      initialized.current = true;
      preferences.forEach((preference) =>
        seenVersions.current.add(preferenceVersion(preference)),
      );
      const newest = newestPreference(preferences);
      if (newest) setPending([newest]);
      return;
    }

    const discoveries = inDiscoveryOrder(
      preferences.filter((preference) => {
        const version = preferenceVersion(preference);
        if (seenVersions.current.has(version)) return false;
        seenVersions.current.add(version);
        return true;
      }),
    );
    if (discoveries.length > 0) {
      setPending((current) => [...current, ...discoveries]);
    }
  }, [active, preferences]);

  useEffect(() => {
    if (active) return;
    if (preferences) {
      initialized.current = true;
      preferences.forEach((preference) =>
        seenVersions.current.add(preferenceVersion(preference)),
      );
    }
    setPending([]);
    setVisiblePreference(null);
    setExpanded(false);
    setCoolingDown(false);
  }, [active, preferences]);

  useEffect(() => {
    if (!active || visiblePreference || coolingDown || pending.length === 0)
      return;
    setVisiblePreference(pending[0]);
    setPending((current) => current.slice(1));
    setExpanded(false);
  }, [active, coolingDown, pending, visiblePreference]);

  useEffect(() => {
    if (!active || !visiblePreference) return undefined;
    const timer = window.setTimeout(
      () => {
        setVisiblePreference(null);
        setExpanded(false);
        setCoolingDown(true);
      },
      expanded ? expandedVisibleMs : visibleMs,
    );
    return () => window.clearTimeout(timer);
  }, [active, expanded, expandedVisibleMs, visibleMs, visiblePreference]);

  useEffect(() => {
    if (!coolingDown) return undefined;
    const timer = window.setTimeout(() => setCoolingDown(false), cooldownMs);
    return () => window.clearTimeout(timer);
  }, [cooldownMs, coolingDown]);

  return {
    visiblePreference,
    expanded,
    toggleExpanded: () => setExpanded((current) => !current),
  };
}
