const CUSTOMIZATION_FIELDS_BY_NODE_TYPE = Object.freeze({
  text: new Set(['fontSize', 'fontFamily', 'textColor', 'backgroundColor']),
  link: new Set(['fontSize', 'fontFamily', 'textColor', 'backgroundColor']),
  group: new Set(['fontSize', 'fontFamily', 'textColor', 'titleSpacing', 'backgroundColor']),
  document: new Set(['backgroundColor']),
  marketplacecard: new Set(['staticGlowColor']),
});

function supportedFieldsFor(type) {
  return Object.hasOwn(CUSTOMIZATION_FIELDS_BY_NODE_TYPE, type)
    ? CUSTOMIZATION_FIELDS_BY_NODE_TYPE[type]
    : null;
}

function findFieldSource(nodes, field) {
  return nodes.find(node => supportedFieldsFor(node.type)?.has(field));
}

export function nodeSupportsCustomization(type) {
  return !!supportedFieldsFor(type);
}

export function filterNodeCustomizationUpdates(node, updates) {
  const supportedFields = supportedFieldsFor(node?.type);
  if (!supportedFields) return {};
  return Object.fromEntries(
    Object.entries(updates).filter(([field, value]) => (
      supportedFields.has(field) && !Object.is(node.data?.[field], value)
    )),
  );
}

export function buildCustomizationDialogData(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const fontNode = findFieldSource(nodes, 'fontSize');
  const spacingNode = findFieldSource(nodes, 'titleSpacing');
  const backgroundNode = findFieldSource(nodes, 'backgroundColor');
  const staticGlowNode = findFieldSource(nodes, 'staticGlowColor');
  if (!fontNode && !spacingNode && !backgroundNode && !staticGlowNode) return null;

  return {
    fontSize: fontNode?.data?.fontSize,
    fontFamily: fontNode?.data?.fontFamily,
    textColor: fontNode?.data?.textColor,
    titleSpacing: spacingNode?.data?.titleSpacing,
    backgroundColor: backgroundNode?.data?.backgroundColor,
    staticGlowColor: staticGlowNode?.data?.staticGlowColor,
    showFont: !!fontNode,
    showSpacing: !!spacingNode,
    showBackground: !!backgroundNode,
    showStaticGlow: !!staticGlowNode,
  };
}
