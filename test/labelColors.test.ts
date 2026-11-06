import { expect, it } from "vitest";
import { labelColor, labelRgb } from "../src/webview/labelColors";
it("assigns distinct stable colors to all 128 labels without repeating the eight-color palette", () => {
  const colors = Array.from({ length: 128 }, (_, i) => labelColor(i + 1));
  expect(new Set(colors).size).toBe(128);
  expect(labelColor(1)).not.toBe(labelColor(9));
  expect([...colors].reverse()).toEqual(
    Array.from({ length: 128 }, (_, i) => labelColor(128 - i)),
  );
  for (let i = 1; i <= 128; i++)
    expect(
      "#" +
        labelRgb(i)
          .map((n) => n.toString(16).padStart(2, "0"))
          .join(""),
    ).toBe(labelColor(i));
});
