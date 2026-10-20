import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withVerifiedCleanup } from "../e2e/verified-cleanup.js";

describe("Runtime E2E cleanup orchestration", () => {
  it("cleans after a passing body", async () => {
    let cleanupCalls = 0;
    await withVerifiedCleanup(
      async () => {},
      async () => { cleanupCalls++; },
    );
    assert.equal(cleanupCalls, 1);
  });

  for (const outcome of ["skip", "fail"] as const) {
    it(`cleans and preserves a ${outcome} outcome`, async () => {
      const expected = new Error(outcome);
      let cleanupCalls = 0;
      await assert.rejects(
        withVerifiedCleanup(
          async () => { throw expected; },
          async () => { cleanupCalls++; },
        ),
        (error) => error === expected,
      );
      assert.equal(cleanupCalls, 1);
    });
  }

  it("reports both body and cleanup failures", async () => {
    await assert.rejects(
      withVerifiedCleanup(
        async () => { throw new Error("body failed"); },
        async () => { throw new Error("cleanup failed"); },
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors.map(String), ["Error: body failed", "Error: cleanup failed"]);
        return true;
      },
    );
  });
});
