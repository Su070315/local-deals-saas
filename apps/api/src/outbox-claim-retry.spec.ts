import { claimWithTransientEmptyRetry } from './outbox-claim-retry';

describe('claimWithTransientEmptyRetry', () => {
  it('retries a transient empty SKIP LOCKED result', async () => {
    const item = { id: 'claimed' };
    const claim = jest.fn<Promise<typeof item | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(item);

    await expect(claimWithTransientEmptyRetry(claim, 3, 0)).resolves.toBe(item);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('stops after the bounded empty confirmation window', async () => {
    const claim = jest.fn<Promise<null>, []>().mockResolvedValue(null);

    await expect(claimWithTransientEmptyRetry(claim, 3, 0)).resolves.toBeNull();
    expect(claim).toHaveBeenCalledTimes(4);
  });
});
