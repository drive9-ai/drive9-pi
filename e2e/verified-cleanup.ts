/** Run an E2E body and always execute its verified remote cleanup. */
export async function withVerifiedCleanup(
  run: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  let runError: unknown;
  let cleanupError: unknown;
  try {
    await run();
  } catch (error) {
    runError = error;
  }
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (runError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([runError, cleanupError], "E2E and cleanup both failed");
  }
  if (runError !== undefined) throw runError;
  if (cleanupError !== undefined) throw cleanupError;
}
