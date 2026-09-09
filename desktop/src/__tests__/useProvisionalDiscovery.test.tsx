import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';

import useProvisionalDiscovery, {
  type ProvisionalPreference,
} from '../renderer/components/useProvisionalDiscovery';

function preference(id: string, content: string): ProvisionalPreference {
  return {
    id,
    section: 'general',
    content,
    helpful: 0,
    harmful: 0,
  };
}

function DiscoveryHarness({
  preferences,
  active,
}: {
  preferences: ProvisionalPreference[];
  active: boolean;
}) {
  const discovery = useProvisionalDiscovery(preferences, {
    active,
    visibleMs: 100,
    expandedVisibleMs: 200,
    cooldownMs: 50,
  });
  return (
    <div>
      <span>{discovery.visiblePreference?.content ?? 'No discovery'}</span>
      <span>{discovery.visiblePreference ? 'Avatar effect' : 'No effect'}</span>
    </div>
  );
}

describe('useProvisionalDiscovery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows each new preference, cools down, and removes the avatar effect', () => {
    const first = preference('first', 'First discovery');
    const second = preference('second', 'Second discovery');
    const { rerender } = render(
      <DiscoveryHarness preferences={[first]} active />,
    );

    expect(screen.getByText('First discovery')).toBeInTheDocument();
    expect(screen.getByText('Avatar effect')).toBeInTheDocument();

    rerender(<DiscoveryHarness preferences={[first, second]} active />);
    expect(screen.getByText('First discovery')).toBeInTheDocument();

    act(() => jest.advanceTimersByTime(100));
    expect(screen.getByText('No discovery')).toBeInTheDocument();
    expect(screen.getByText('No effect')).toBeInTheDocument();

    act(() => jest.advanceTimersByTime(50));
    expect(screen.getByText('Second discovery')).toBeInTheDocument();
    expect(screen.getByText('Avatar effect')).toBeInTheDocument();

    act(() => jest.advanceTimersByTime(100));
    expect(screen.getByText('No discovery')).toBeInTheDocument();
    expect(screen.getByText('No effect')).toBeInTheDocument();
  });

  it('clears the current and queued discoveries when the run finishes', () => {
    const first = preference('first', 'First discovery');
    const second = preference('second', 'Second discovery');
    const { rerender } = render(
      <DiscoveryHarness preferences={[first, second]} active />,
    );

    expect(screen.getByText('Second discovery')).toBeInTheDocument();
    rerender(<DiscoveryHarness preferences={[first, second]} active={false} />);

    expect(screen.getByText('No discovery')).toBeInTheDocument();
    expect(screen.getByText('No effect')).toBeInTheDocument();

    act(() => jest.advanceTimersByTime(1000));
    expect(screen.getByText('No discovery')).toBeInTheDocument();
  });
});
