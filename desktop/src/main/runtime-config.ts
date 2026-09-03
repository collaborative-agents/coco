import { createServer } from 'net';
import log from 'electron-log';
import type { ServiceManager } from './services/manager';

function requestedPort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
}

export function requestedPersonalizationConcurrency(
  value: string | undefined,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : 4;
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(
  preferred: number,
  excluded: Set<number>,
): Promise<number> {
  if (!excluded.has(preferred) && (await canBindPort(preferred))) {
    return preferred;
  }
  for (let candidate = 49152; candidate <= 65535; candidate += 1) {
    // Port probes are intentionally sequential so we stop at the first match.
    // eslint-disable-next-line no-await-in-loop
    if (!excluded.has(candidate) && (await canBindPort(candidate))) {
      return candidate;
    }
  }
  throw new Error('Coco could not find an available local service port.');
}

export async function configureLocalServicePorts(
  serviceManager: ServiceManager,
): Promise<void> {
  const requestedSensingPort = requestedPort(process.env.SENSING_PORT, 8080);
  const requestedTutorPort = requestedPort(process.env.TUTOR_PORT, 8081);
  const selected = new Set<number>();
  const sensingPort = await findAvailablePort(requestedSensingPort, selected);
  selected.add(sensingPort);
  const tutorPort = await findAvailablePort(requestedTutorPort, selected);

  process.env.SENSING_PORT = String(sensingPort);
  process.env.TUTOR_PORT = String(tutorPort);
  serviceManager.configureServiceArg(
    'sensing-server',
    'port',
    String(sensingPort),
  );
  serviceManager.configureServiceArg('tutor-server', 'port', String(tutorPort));
  serviceManager.configureServiceArg(
    'sensing-server',
    'tutor_url',
    `http://127.0.0.1:${tutorPort}`,
  );
  const portEnv = {
    SENSING_PORT: String(sensingPort),
    TUTOR_PORT: String(tutorPort),
  };
  serviceManager.configureServiceEnv('sensing-server', portEnv);
  serviceManager.configureServiceEnv('tutor-server', portEnv);

  if (
    sensingPort !== requestedSensingPort ||
    tutorPort !== requestedTutorPort
  ) {
    log.warn(
      `[Ports] Requested sensing=${requestedSensingPort}, tutor=${requestedTutorPort}; ` +
        `using sensing=${sensingPort}, tutor=${tutorPort} because a port was occupied.`,
    );
  } else {
    log.info(`[Ports] sensing=${sensingPort}, tutor=${tutorPort}`);
  }
}
