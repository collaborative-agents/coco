import fs from 'fs';
import os from 'os';
import path from 'path';
import { CocoGatewayClient } from './gateway-client';
import GatewayOutbox from './gateway-outbox';

describe('GatewayOutbox', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-outbox-test-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('retains failed writes and delivers them after restart', async () => {
    const failingClient = {
      deliver: jest.fn().mockRejectedValue(new Error('offline')),
      storageNamespace: jest.fn().mockReturnValue('study-example'),
    } as unknown as CocoGatewayClient;
    const first = new GatewayOutbox(directory, 'Participant-1', failingClient);
    first.enqueue('message', { _id: 'message-1' });
    await first.flush();
    expect(first.pendingCount()).toBe(1);

    const successfulClient = {
      deliver: jest.fn().mockResolvedValue(undefined),
      storageNamespace: jest.fn().mockReturnValue('study-example'),
    } as unknown as CocoGatewayClient;
    const restored = new GatewayOutbox(
      directory,
      'Participant-1',
      successfulClient,
    );
    expect(restored.pendingCount()).toBe(1);
    await restored.flush();

    expect(successfulClient.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        payload: { _id: 'message-1' },
      }),
    );
    expect(restored.pendingCount()).toBe(0);
    expect(
      fs.statSync(
        path.join(
          directory,
          'coco-gateway-outbox-study-example-participant-1.json',
        ),
      ).mode % 0o1000,
    ).toBe(0o600);
  });
});
