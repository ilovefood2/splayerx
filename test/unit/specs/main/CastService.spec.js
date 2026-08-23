import { beforeEach, describe, expect, it, vi } from 'vitest';

const discoverWithKnown = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/main/helpers/cast/CastDiscovery', () => ({
  discoverWithKnown,
}));

import { CastService } from '../../../../src/main/helpers/cast/CastService';

describe('CastService discovery lifecycle', () => {
  beforeEach(() => {
    discoverWithKnown.mockReset();
  });

  it('does not start discovery until the user opens the cast picker', async () => {
    const service = new CastService();
    const devices = [{
      id: 'living-room._googlecast._tcp.local',
      name: 'Living Room',
      host: 'living-room.local',
      port: 8009,
    }];
    discoverWithKnown.mockResolvedValue(devices);

    expect(discoverWithKnown).not.toHaveBeenCalled();
    await expect(service.listDevices(250)).resolves.toEqual(devices);
    expect(discoverWithKnown).toHaveBeenCalledOnce();
    expect(discoverWithKnown).toHaveBeenCalledWith([], 250);
  });

  it('returns cached devices immediately and refreshes only after a picker request', async () => {
    const service = new CastService();
    const initial = [{
      id: 'bedroom._googlecast._tcp.local',
      name: 'Bedroom',
      host: 'bedroom.local',
      port: 8009,
    }];
    discoverWithKnown.mockResolvedValueOnce(initial).mockResolvedValueOnce(initial);

    await service.listDevices();
    await expect(service.listDevices()).resolves.toEqual(initial);

    expect(discoverWithKnown).toHaveBeenCalledTimes(2);
    expect(discoverWithKnown).toHaveBeenLastCalledWith(initial, undefined);
  });
});
