/** CT display starting points, in HU after NIfTI intensity scaling.
 * https://radiopaedia.org/articles/windowing-ct
 * MRI intensities have no universal equivalent; use automatic/manual windowing.
 */
export const CT_WINDOW_PRESETS = [
  { id: "brain", group: "CT · 头颈", name: "脑组织", width: 80, level: 40 },
  {
    id: "subdural",
    group: "CT · 头颈",
    name: "硬膜下",
    width: 300,
    level: 100,
  },
  {
    id: "stroke",
    group: "CT · 头颈",
    name: "脑卒中窄窗",
    width: 40,
    level: 40,
  },
  {
    id: "temporal-bone",
    group: "CT · 头颈",
    name: "颞骨",
    width: 2800,
    level: 600,
  },
  {
    id: "neck-soft-tissue",
    group: "CT · 头颈",
    name: "头颈软组织",
    width: 400,
    level: 40,
  },
  { id: "lung", group: "CT · 胸部", name: "肺", width: 1500, level: -600 },
  {
    id: "mediastinum",
    group: "CT · 胸部",
    name: "纵隔",
    width: 350,
    level: 50,
  },
  {
    id: "angiography",
    group: "CT · 胸部",
    name: "血管 / 心脏",
    width: 600,
    level: 200,
  },
  {
    id: "abdomen",
    group: "CT · 腹部",
    name: "腹部软组织",
    width: 400,
    level: 50,
  },
  { id: "liver", group: "CT · 腹部", name: "肝脏", width: 150, level: 30 },
  {
    id: "spine-soft-tissue",
    group: "CT · 脊柱",
    name: "脊柱软组织",
    width: 250,
    level: 50,
  },
  { id: "bone", group: "CT · 脊柱", name: "骨", width: 1800, level: 400 },
] as const;

export function populateWindowPresets(select: HTMLSelectElement): void {
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const preset of CT_WINDOW_PRESETS) {
    let group = groups.get(preset.group);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = preset.group;
      groups.set(preset.group, group);
      select.append(group);
    }
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    group.append(option);
  }
}
