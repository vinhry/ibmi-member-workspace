import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCheckoutIndex } from "../types";

describe("parseCheckoutIndex", () => {
  it("parses a valid index", () => {
    const index = parseCheckoutIndex(JSON.stringify({ version: 1, entries: [] }));
    assert.deepEqual(index, { version: 1, entries: [] });
  });

  it("defaults a missing version to 1", () => {
    assert.equal(parseCheckoutIndex(JSON.stringify({ entries: [] })).version, 1);
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseCheckoutIndex("{ not json"));
  });

  it("throws when the entries list is missing", () => {
    assert.throws(() => parseCheckoutIndex(JSON.stringify({ version: 1 })));
    assert.throws(() => parseCheckoutIndex("null"));
  });
});
