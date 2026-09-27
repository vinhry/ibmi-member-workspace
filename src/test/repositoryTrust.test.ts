import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RepositoryTrust, TrustStore, repositoryKey } from "../repositoryTrust";

function memoryStore(initial: Record<string, unknown> = {}): TrustStore & { values: Record<string, unknown> } {
  const values = { ...initial };
  return {
    values,
    get: <T>(key: string, defaultValue: T) => (key in values ? values[key] as T : defaultValue),
    update: async (key: string, value: unknown) => {
      values[key] = value;
    },
  };
}

describe("repositoryKey", () => {
  it("ignores case where the file system does", () => {
    assert.equal(repositoryKey("/Users/dev/Checkouts/PUB400", "darwin"), "/users/dev/checkouts/pub400");
    assert.equal(repositoryKey("C:\\Checkouts\\PUB400", "win32"), "c:\\checkouts\\pub400");
    assert.equal(repositoryKey("/home/dev/Checkouts/PUB400", "linux"), "/home/dev/Checkouts/PUB400");
  });

  it("resolves . and .. so one folder has one key", () => {
    assert.equal(repositoryKey("/home/dev/checkouts/../checkouts/./PUB400", "linux"), "/home/dev/checkouts/PUB400");
  });
});

describe("RepositoryTrust", () => {
  it("trusts nothing until a repository is recorded", async () => {
    const trust = new RepositoryTrust(memoryStore(), "linux");
    assert.equal(trust.isTrusted("/home/dev/checkouts/PUB400"), false);

    await trust.trust("/home/dev/checkouts/PUB400");
    assert.equal(trust.isTrusted("/home/dev/checkouts/PUB400"), true);
    assert.equal(trust.isTrusted("/home/dev/checkouts/PROD400"), false);
  });

  it("does not trust a sibling or a folder inside a trusted one", async () => {
    const trust = new RepositoryTrust(memoryStore(), "linux");
    await trust.trust("/home/dev/checkouts/PUB400");
    assert.equal(trust.isTrusted("/home/dev/checkouts/PUB400/LIB"), false);
    assert.equal(trust.isTrusted("/home/dev/checkouts/PUB4000"), false);
  });

  it("matches a folder spelled with different case on macOS", async () => {
    const trust = new RepositoryTrust(memoryStore(), "darwin");
    await trust.trust("/Users/dev/Checkouts/PUB400");
    assert.equal(trust.isTrusted("/users/dev/checkouts/pub400"), true);
  });

  it("keeps each folder once and ignores a malformed stored list", async () => {
    const store = memoryStore({ trustedRepositories: "not a list" });
    const trust = new RepositoryTrust(store, "linux");
    assert.equal(trust.isTrusted("/x"), false);
    await trust.trust("/x");
    await trust.trust("/x");
    assert.deepEqual(store.values.trustedRepositories, ["/x"]);
  });
});
