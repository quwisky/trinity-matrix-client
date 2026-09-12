const EXPLICIT_ID = /\s+\{#([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}$/;

const applyHeadingId = (node) => {
  if (node.type !== 'heading' || !Array.isArray(node.children)) return;

  const lastChild = node.children.at(-1);
  if (lastChild?.type !== 'text' || typeof lastChild.value !== 'string') {
    return;
  }

  const match = lastChild.value.match(EXPLICIT_ID);
  if (!match) return;

  const [, id] = match;
  lastChild.value = lastChild.value.slice(0, match.index).trimEnd();
  if (lastChild.value.length === 0) node.children.pop();
  node.data = {
    ...node.data,
    hProperties: { ...node.data?.hProperties, id },
  };
};

const visit = (node) => {
  applyHeadingId(node);
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) visit(child);
};

export default function explicitHeadingIds() {
  return visit;
}
