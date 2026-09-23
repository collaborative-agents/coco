import '@testing-library/jest-dom';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import PersonalizationCenter, {
  PersonalizationSettingsCard,
  PersonalizationStatusPanel,
} from '../renderer/components/PersonalizationCenter';

const status = {
  available: true,
  sleeping: true,
  successfulUpdateCount: 2,
  state: 'running' as const,
  activeJob: 'evolve' as const,
  checkpointStatus: 'running',
  processedSamples: 8,
  totalSamples: 16,
  signals: {
    signalCount: 4,
    observationCount: 20,
    feedbackEventCount: 2,
  },
};

const center = {
  provisional: [
    {
      id: 'm-1',
      section: 'how_to_support',
      content: 'Lead with a concise explanation.',
      helpful: 2,
      harmful: 0,
    },
  ],
  activity: [
    {
      id: 'batch-1',
      kind: 'batch' as const,
      title: 'Checkpointed batch 2',
      detail: '1 preference change saved at this checkpoint.',
    },
  ],
  review: {
    draft: {
      draftId: 'draft-1',
      createdAt: 1,
      periodEnd: 1,
      summary: 'Daily update',
      bullets: [
        {
          id: 'preference-1',
          section: 'when_to_support',
          content: 'Offer help after repeated formatting attempts.',
          confidence: 0.9,
          examples: ['The same report table was reformatted three times.'],
        },
      ],
    },
    decisions: {},
  },
  history: [],
};

describe('PersonalizationCenter', () => {
  it('uses sleeping, training, and waiting Coco art for the run state', () => {
    const { rerender } = render(
      <PersonalizationStatusPanel
        status={{ ...status, state: 'idle' }}
        loading={false}
        onExpand={jest.fn()}
        readyCount={0}
        waitingForReview={false}
      />,
    );
    expect(screen.getByAltText('Coco sleeping')).toBeInTheDocument();

    rerender(
      <PersonalizationStatusPanel
        status={status}
        loading={false}
        onExpand={jest.fn()}
        readyCount={0}
        waitingForReview={false}
      />,
    );
    expect(screen.getByAltText('Coco training')).toBeInTheDocument();

    rerender(
      <PersonalizationStatusPanel
        status={{ ...status, state: 'completed' }}
        loading={false}
        onExpand={jest.fn()}
        readyCount={1}
        waitingForReview
      />,
    );
    expect(screen.getByAltText('Waiting Coco')).toBeInTheDocument();
  });

  it('opens from a compact Settings card', async () => {
    const onOpen = jest.fn();
    (window as any).electron = {
      ipcRenderer: {
        invoke: jest.fn().mockResolvedValue({ status, center }),
        on: jest.fn(),
        sendMessage: jest.fn(),
      },
    };

    render(<PersonalizationSettingsCard onOpen={onOpen} />);

    await waitFor(() => {
      expect(
        screen.getByText('Self-evolving prompt is running'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText('Self-evolving prompt is running'),
    ).toBeInTheDocument();
    const expand = screen.getByRole('button', {
      name: 'Expand Personalization',
    });
    expect(expand).toHaveAttribute(
      'title',
      'Expand Personalization · 1 ready to review',
    );
    fireEvent.click(expand);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('clears discoveries when the run enters the summary stage', async () => {
    (window as any).electron = {
      ipcRenderer: {
        invoke: jest.fn().mockResolvedValue({
          status: { ...status, checkpointStatus: 'finalizing' },
          center: { ...center, review: null },
        }),
        on: jest.fn(),
        sendMessage: jest.fn(),
      },
    };

    render(<PersonalizationCenter onBack={jest.fn()} />);

    expect(
      await screen.findByLabelText('Summarize: current'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Just learned')).not.toBeInTheDocument();
    expect(screen.getByAltText('Coco training').parentElement).not.toHaveClass(
      'personalization-run-animation--discovered',
    );
  });

  it('shows indeterminate preparation instead of stale completed progress', async () => {
    (window as any).electron = {
      ipcRenderer: {
        invoke: jest.fn().mockResolvedValue({
          status: {
            ...status,
            checkpointStatus: 'preparing',
            preparation: {
              completedSteps: 4,
              totalSteps: 10,
              totalObservations: 80,
              remainingObservations: 60,
              estimatedSecondsRemaining: 600,
            },
            processedSamples: undefined,
            totalSamples: undefined,
          },
          center,
        }),
        on: jest.fn(),
        sendMessage: jest.fn(),
      },
    };

    render(<PersonalizationCenter onBack={jest.fn()} />);

    expect(
      await screen.findByText('Preparing the learning run'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Collect: current')).toBeInTheDocument();
    expect(screen.getByLabelText('Learn: waiting')).toBeInTheDocument();
    expect(screen.queryByText(/moments processed/)).not.toBeInTheDocument();
    expect(screen.getByText(/About 10 min remaining/)).toBeInTheDocument();
    expect(screen.getByText('60').parentElement).toHaveTextContent(
      '60 observations to process',
    );
    expect(screen.queryByText(/completed updates/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', {
        name: 'Personalization run progress',
      }),
    ).toHaveAttribute('aria-valuetext', 'Preparing current run');
    expect(screen.queryByText('Just learned')).not.toBeInTheDocument();
  });

  it('shows live checkpoints and persists a card-by-card review', async () => {
    const invoke = jest.fn((channel: string) => {
      if (channel === 'get-personalization-center') {
        return Promise.resolve({ status, center });
      }
      if (channel === 'save-personalization-review-decision') {
        return Promise.resolve({
          success: true,
          center: {
            ...center,
            review: {
              ...center.review,
              decisions: {
                'preference-1': {
                  decision: 'keep',
                  decidedAt: Date.now(),
                },
              },
            },
          },
        });
      }
      if (channel === 'apply-personalization-review') {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve(undefined);
    });
    (window as any).electron = {
      ipcRenderer: { invoke, on: jest.fn(), sendMessage: jest.fn() },
    };

    render(<PersonalizationCenter onBack={jest.fn()} />);

    expect(
      await screen.findByText('8 of 16 moments processed'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('See what Coco is learning and review updates'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Refresh' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '← Settings' }),
    ).not.toBeInTheDocument();
    const overview = screen
      .getByRole('progressbar', { name: 'Personalization run progress' })
      .closest<HTMLElement>('.personalization-overview');
    expect(overview).not.toBeNull();
    expect(
      within(overview!).getByText('Checkpointed batch 2'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Collect: done')).toBeInTheDocument();
    expect(screen.getByLabelText('Learn: current')).toBeInTheDocument();
    expect(screen.queryByText('Learning now')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Provisional preferences' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/\d+ provisional preferences?/i),
    ).not.toBeInTheDocument();
    expect(await screen.findByText('Just learned')).toBeInTheDocument();
    expect(
      screen.getByText('Lead with a concise explanation.'),
    ).toBeInTheDocument();
    expect(screen.getByAltText('Coco training').parentElement).toHaveClass(
      'personalization-run-animation--discovered',
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Show details for learned preference',
      }),
    );
    expect(screen.getByText('What this means')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Hide details for learned preference',
      }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText('Offer help after repeated formatting attempts.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    const keepButton = screen.getByRole('button', { name: '✓ Keep' });
    expect(keepButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(keepButton);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'save-personalization-review-decision',
        expect.objectContaining({
          draftId: 'draft-1',
          bulletId: 'preference-1',
          decision: 'keep',
        }),
      );
    });
    expect(
      await screen.findByRole('button', { name: 'Apply choices' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: '✓ Keep' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
