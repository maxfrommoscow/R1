import test from "node:test";
import assert from "node:assert/strict";
import { parseFreeSlots } from "../src/index.js";

test("extracts only free slots from the target day", () => {
  const html = `
    <div class="slotContainer slotLocked" data-time="14.08.2026 08:00">Not available</div>
    <div class="slotContainer slotFree" data-time="14.08.2026 09:00">Available</div>
    <div data-time='14.08.2026 12:00' class='slotContainer slotFree'>Available</div>
    <div class="slotContainer slotFree" data-time="15.08.2026 10:00">Available</div>`;
  assert.deepEqual(parseFreeSlots(html, "14.08.2026"), ["09:00", "12:00"]);
});

test("returns an empty list when every slot is locked", () => {
  const html = `<div class="slotContainer slotLocked" data-time="14.08.2026 08:00">Not available</div>`;
  assert.deepEqual(parseFreeSlots(html, "14.08.2026"), []);
});
