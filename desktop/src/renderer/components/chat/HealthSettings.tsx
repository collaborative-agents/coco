import type React from 'react';
import { S } from './styles';
import type {
  SystemPermissionHealth,
  SystemPermissionTarget,
  ServiceHealthView,
} from './types';

interface Props {
  cocoSleeping: boolean;
  systemPermissionHealth: SystemPermissionHealth;
  permissionOpening: SystemPermissionTarget | null;
  openSystemPermission: (target: SystemPermissionTarget) => Promise<void>;
  permissionError: string;
  serviceHealth: ServiceHealthView | null;
  healthLoading: boolean;
  refreshServiceHealth: (forceModelTest?: boolean) => Promise<void>;
  healthError: string;
}

export default function HealthSettings({
  cocoSleeping,
  systemPermissionHealth,
  permissionOpening,
  openSystemPermission,
  permissionError,
  serviceHealth,
  healthLoading,
  refreshServiceHealth,
  healthError,
}: Props) {
  return (
    <section
      className="workspace-settings-section"
      aria-labelledby="health-heading"
    >
      <h2 id="health-heading" className="settings-heading">
        Coco Health
      </h2>
      <div style={S.helpText}>
        {cocoSleeping
          ? 'Coco is asleep. Service health checks are paused until Coco wakes.'
          : 'Checks services and models with short test requests, including a test image.'}
      </div>
      {systemPermissionHealth.missing.length > 0 && (
        <div role="alert" style={S.healthList}>
          {systemPermissionHealth.missing.map((permission) => (
            <div key={permission.target} style={S.healthRow}>
              <span style={{ ...S.healthDot, background: '#ef4444' }} />
              <div style={{ flex: 1 }}>
                <div style={S.healthName}>
                  {permission.label} permission required
                </div>
                <div style={{ ...S.healthDetail, color: '#b45309' }}>
                  {permission.explanation}
                </div>
                <button
                  type="button"
                  style={{
                    ...S.connectionTestButton,
                    marginTop: 7,
                    ...(permissionOpening ? S.sendBtnDisabled : {}),
                  }}
                  disabled={permissionOpening !== null}
                  onClick={() => void openSystemPermission(permission.target)}
                >
                  {permissionOpening === permission.target
                    ? 'Opening…'
                    : permission.actionLabel}
                </button>
              </div>
            </div>
          ))}
          {permissionError && (
            <div
              style={{
                color: 'var(--coco-color-danger)',
                fontSize: 'var(--coco-text-secondary)',
              }}
            >
              {permissionError}
            </div>
          )}
        </div>
      )}
      {cocoSleeping && (
        <div role="status" style={S.healthDetail}>
          Sleeping intentionally stops the sensing server and tutor agent.
        </div>
      )}
      {!cocoSleeping && (
        <div style={S.healthList}>
          {(
            [
              ['sensing', 'Sensing server', serviceHealth?.sensing],
              ['tutor', 'Tutor agent', serviceHealth?.tutor],
            ] as const
          ).map(([key, label, health]) => {
            const serviceStatusLabel = health
              ? `${health.connected ? 'Connected' : 'Not connected'} (service)`
              : `${healthLoading ? 'Checking…' : 'Not checked'} (service)`;
            const modelAssessment = health?.modelAssessment;
            const modelStatusLabel = modelAssessment
              ? modelAssessment.status === 'verified'
                ? 'Connected (model)'
                : modelAssessment.status === 'failed'
                  ? 'Not connected (model)'
                  : modelAssessment.status === 'not_configured'
                    ? 'Not configured (model)'
                    : 'Not assessed (model)'
              : `${healthLoading ? 'Checking…' : 'Not checked'} (model)`;
            const modelDetail = modelAssessment?.detail
              ?.replace(/^Connected\s*[—-]\s*/i, '')
              .replace(/^Connected\.?$/i, '');
            const details = [
              serviceStatusLabel,
              health?.detail,
              `${modelStatusLabel}${modelDetail ? ` — ${modelDetail}` : ''}`,
            ].filter(Boolean);
            const hasHealthIssue = Boolean(
              health &&
                (!health.connected || modelAssessment?.status === 'failed'),
            );
            const isFullyConnected = Boolean(
              health?.connected && modelAssessment?.status === 'verified',
            );
            return (
              <div
                key={key}
                style={S.healthRow}
                aria-label={`${label}: ${serviceStatusLabel}; ${modelStatusLabel}`}
              >
                <span
                  style={{
                    ...S.healthDot,
                    background: health
                      ? hasHealthIssue
                        ? '#ef4444'
                        : isFullyConnected
                          ? '#22c55e'
                          : '#f59e0b'
                      : 'var(--coco-color-border)',
                  }}
                />
                <div style={{ flex: 1 }}>
                  <div style={S.healthName}>{label}</div>
                  <div
                    style={{
                      ...S.healthDetail,
                      color: hasHealthIssue
                        ? '#dc2626'
                        : isFullyConnected
                          ? 'var(--coco-color-success)'
                          : health
                            ? '#b45309'
                            : undefined,
                    }}
                  >
                    {details.join(' · ')}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!cocoSleeping && (
        <div style={S.healthActions}>
          <button
            type="button"
            style={{ ...S.addBtn, ...(healthLoading ? S.sendBtnDisabled : {}) }}
            disabled={healthLoading}
            onClick={() => void refreshServiceHealth(true)}
          >
            {healthLoading ? 'Checking…' : 'Check again'}
          </button>
          {serviceHealth && !healthLoading && (
            <span style={S.healthDetail}>
              Checked {new Date(serviceHealth.checkedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}
      {!cocoSleeping && healthError && (
        <div
          style={{
            color: 'var(--coco-color-danger)',
            fontSize: 'var(--coco-text-secondary)',
            marginBottom: 12,
          }}
        >
          Health check failed: {healthError}
        </div>
      )}
    </section>
  );
}
