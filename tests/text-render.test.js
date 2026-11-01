import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenizeActions } from "../public/text-render.js";

test("asterisk actions become action segments without delimiters; other text stays plain", () => {
  assert.deepEqual(tokenizeActions("*sits beside you* Let me tell you something."), [
    { type: "action", text: "sits beside you" }, { type: "text", text: " Let me tell you something." }
  ]);
  assert.deepEqual(tokenizeActions("a *b* c *d*"), [{ type: "text", text: "a " }, { type: "action", text: "b" }, { type: "text", text: " c " }, { type: "action", text: "d" }]);
});

test("unmatched or empty asterisks stay literal; HTML stays literal text; multiline is preserved", () => {
  assert.deepEqual(tokenizeActions("2 * 3 = 6"), [{ type: "text", text: "2 * 3 = 6" }]);
  assert.deepEqual(tokenizeActions("** nothing"), [{ type: "text", text: "** nothing" }]);
  assert.deepEqual(tokenizeActions("<b>x</b>\nline"), [{ type: "text", text: "<b>x</b>\nline" }]);
  assert.deepEqual(tokenizeActions("*stands\nup* ok"), [{ type: "action", text: "stands\nup" }, { type: "text", text: " ok" }]);
});
