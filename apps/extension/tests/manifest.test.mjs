import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
)

test("disallows running the extension in incognito", () => {
  assert.equal(manifest.incognito, "not_allowed")
})
