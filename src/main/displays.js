function chooseTargetDisplay(displays, primaryDisplay, preference = 'primary') {
  const list = Array.isArray(displays) ? displays.filter(Boolean) : [];
  const primary = primaryDisplay || list[0] || null;
  if (!primary) return null;

  if (preference === 'secondary') {
    return list.find(display => String(display.id) !== String(primary.id)) || primary;
  }

  if (preference && preference !== 'primary') {
    const requestedId = String(preference).replace(/^id:/, '');
    return list.find(display => String(display.id) === requestedId) || primary;
  }

  return primary;
}

function displayBounds(display) {
  const bounds = display && display.bounds;
  if (!bounds) return null;
  return {
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    width: Math.max(1, Number(bounds.width) || 1),
    height: Math.max(1, Number(bounds.height) || 1)
  };
}

module.exports = { chooseTargetDisplay, displayBounds };
