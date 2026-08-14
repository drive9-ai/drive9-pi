import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

interface Drive9Schema {
  $schema: string;
  additionalProperties: boolean;
  required: string[];
  properties: {
    root: {
      pattern: string;
    };
  };
}

const schemaPath = new URL("../schema/drive9.schema.json", import.meta.url);

describe("published Drive9 project config schema", () => {
  it("is strict JSON Schema 2020-12 with the complete config shape", async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Drive9Schema;

    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["version", "enabled", "root"]);
  });

  it("accepts canonical Drive9 roots and rejects ambiguous or unsafe paths", async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Drive9Schema;
    const rootPattern = new RegExp(schema.properties.root.pattern, "u");

    for (const root of ["/workspace", "/workspaces/team project", "/café", "/a.b/_c-1"]) {
      assert.equal(rootPattern.test(root), true, `expected schema to accept ${JSON.stringify(root)}`);
    }
    for (const root of [
      "/",
      "/.",
      "/..",
      "/a/.",
      "/a/..",
      "/a//b",
      "/a/",
      "relative",
      "/a%2Fb",
      "/a?b",
      "/a#b",
      "/a\\b",
      "/a\nb",
    ]) {
      assert.equal(rootPattern.test(root), false, `expected schema to reject ${JSON.stringify(root)}`);
    }
  });
});
