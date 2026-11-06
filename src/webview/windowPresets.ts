/** CT display starting points, in HU after NIfTI intensity scaling.
 * https://radiopaedia.org/articles/windowing-ct
 * MRI intensities have no universal equivalent; use automatic/manual windowing.
 */
export const CT_WINDOW_PRESETS = [
  { id: "brain", name: "Brain", width: 80, level: 40 },
  { id: "lung", name: "Lung", width: 1500, level: -600 },
  { id: "angiography", name: "Vessel", width: 600, level: 200 },
  { id: "mediastinum", name: "Chest", width: 350, level: 50 },
  { id: "bone", name: "Bone", width: 1800, level: 400 },
] as const;

export function populateWindowPresets(select: HTMLSelectElement): void {
  for (const preset of CT_WINDOW_PRESETS) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    select.append(option);
  }
}
