const DEFAULT_EMPTY_CLAIM_RETRIES = 3;
const DEFAULT_EMPTY_CLAIM_DELAY_MS = 10;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * PostgreSQL SKIP LOCKED can legitimately yield no row while another worker
 * is committing the oldest claim. Confirm the queue is still empty before a
 * processor ends its batch, without ever making a fresh PROCESSING row
 * eligible for takeover.
 */
export async function claimWithTransientEmptyRetry<T>(
  claim: () => Promise<T | null>,
  retries = DEFAULT_EMPTY_CLAIM_RETRIES,
  delayMs = DEFAULT_EMPTY_CLAIM_DELAY_MS,
): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const item = await claim();
    if (item || attempt === retries) return item;
    await delay(delayMs);
  }
  return null;
}
