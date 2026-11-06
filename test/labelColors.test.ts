import { expect, it } from "vitest";
import { labelColor, labelRgb } from "../src/webview/labelColors";
it("assigns distinct stable colors to all 255 labels without repeating the eight-color palette", () => {
  const colors = Array.from({ length: 255 }, (_, i) => labelColor(i + 1));
  expect(new Set(colors).size).toBe(255);
  expect(labelColor(1)).not.toBe(labelColor(9));
  expect([...colors].reverse()).toEqual(
    Array.from({ length: 255 }, (_, i) => labelColor(255 - i)),
  );
  for (let i = 1; i <= 255; i++)
    expect(
      "#" +
        labelRgb(i)
          .map((n) => n.toString(16).padStart(2, "0"))
          .join(""),
    ).toBe(labelColor(i));
});
