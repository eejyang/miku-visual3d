// Stable label colors, shared by 2D slices and 3D surfaces across all files.
const first = [
  "#50bde9",
  "#f5aa54",
  "#a98cf5",
  "#69d6a3",
  "#f07fa4",
  "#e0d465",
  "#78a4f5",
  "#db8e60",
];
const cache = new Map<
  number,
  { hex: string; rgb: readonly [number, number, number] }
>();
function color(label: number) {
  const id = Math.max(1, Math.round(label));
  const cached = cache.get(id);
  if (cached) return cached;
  let hex = first[id - 1];
  if (!hex) {
    const h = ((id * 137.50776405) % 360) / 60,
      s = 0.68,
      l = 0.56 + (id % 3) * 0.05;
    const c = (1 - Math.abs(2 * l - 1)) * s,
      x = c * (1 - Math.abs((h % 2) - 1)),
      m = l - c / 2;
    const rgb =
      h < 1
        ? [c, x, 0]
        : h < 2
          ? [x, c, 0]
          : h < 3
            ? [0, c, x]
            : h < 4
              ? [0, x, c]
              : h < 5
                ? [x, 0, c]
                : [c, 0, x];
    hex = `#${rgb
      .map((v) =>
        Math.round((v + m) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  }
  const rgb = [1, 3, 5].map((offset) =>
    parseInt(hex.slice(offset, offset + 2), 16),
  ) as [number, number, number];
  const value = { hex, rgb };
  cache.set(id, value);
  return value;
}
export const labelColor = (label: number) => color(label).hex;
export const labelRgb = (label: number) => color(label).rgb;
