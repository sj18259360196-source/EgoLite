// A logical Agent target and the tab visible to the user are independent.
export function popupOpenPolicy({ sourceVisible, disposition }) {
  const active = disposition !== 'background-tab';
  return { active, visual: Boolean(sourceVisible && active) };
}

export function extensionOpenPolicy(details = {}) {
  const active = details.active !== false;
  return { active, visual: active };
}
