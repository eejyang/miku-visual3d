// Small, consistent inline icons; no remote fonts or runtime dependency.
const paths = {
  "folder-open": '<path d="M3 7V4h6l2 2h10v4M3 7v13h17l3-10H7L3 20"/>',
  layout:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M3 12h18"/>',
  crosshair:
    '<circle cx="12" cy="12" r="7"/><path d="M12 2v6m0 8v6M2 12h6m8 0h6"/>',
  palette:
    '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4 2 2 0 0 1 1-4h3a3 3 0 0 0 3-3c0-4-4-7-9-7Z"/><path d="M7 10h.01M10 6h.01M15 6h.01M18 9h.01"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
  "rotate-ccw": '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>',
  "refresh-cw":
    '<path d="M21 10a9 9 0 0 0-15-6L3 7m0-5v5h5M3 14a9 9 0 0 0 15 6l3-3m0 5v-5h-5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  "trash-2":
    '<path d="M3 6h18M9 6V3h6v3M5 6v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6M10 10v7m4-7v7"/>',
  layers: '<path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off":
    '<path d="m3 3 18 18M10 5a11 11 0 0 1 12 7 19 19 0 0 1-4 5M6 6a19 19 0 0 0-4 6s4 7 10 7a12 12 0 0 0 5-1M10 10a3 3 0 0 0 4 4"/>',
  "locate-fixed":
    '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>',
  box: '<path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10 9-5M3 8l9 5v9M7 5l10 6"/>',
  "grid-3x3":
    '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18m6-18v18M3 9h18M3 15h18"/>',
};
export function icon(name: keyof typeof paths): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
