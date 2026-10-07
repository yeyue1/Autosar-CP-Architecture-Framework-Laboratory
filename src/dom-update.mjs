// Keep controls mounted while virtual-clock output changes. Replacing a pressed
// button between pointerdown and pointerup can prevent its click from firing.
const identityAttributes = [
  'id', 'name', 'data-form', 'data-ext', 'data-ecu', 'data-kind',
  'data-system-profile', 'data-system-node', 'data-system-seek', 'data-system-action',
  'data-module-guide', 'data-system-lab', 'data-breakpoint', 'data-jump',
];
const formAttributes = new Set(['value', 'checked', 'selected']);
const isFormNode = node => ['INPUT', 'SELECT', 'TEXTAREA', 'OPTION'].includes(node.nodeName);
const key = node => node.nodeType === 1
  ? identityAttributes.map(name => node.getAttribute(name) ?? '').join('|') : '';
const compatible = (current, next) => current.nodeType === next.nodeType
  && current.nodeName === next.nodeName && key(current) === key(next);

function patchNode(current, next, preserveFormValues) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  const preserve = preserveFormValues && isFormNode(current);
  for (const { name } of [...current.attributes]) {
    if (!next.hasAttribute(name) && !(preserve && formAttributes.has(name))) current.removeAttribute(name);
  }
  for (const { name, value } of next.attributes) {
    if (!(preserve && formAttributes.has(name)) && current.getAttribute(name) !== value) current.setAttribute(name, value);
  }
  patchChildren(current, next, preserveFormValues);
  if (!preserve) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(current.nodeName) && current.value !== next.value) current.value = next.value;
    if (current.nodeName === 'INPUT' && current.checked !== next.checked) current.checked = next.checked;
  }
}

function patchChildren(current, next, preserveFormValues) {
  let index = 0;
  for (const desired of [...next.childNodes]) {
    let existing = current.childNodes[index];
    if (!existing || !compatible(existing, desired)) {
      const match = [...current.childNodes].slice(index + 1).find(node => compatible(node, desired));
      if (match) {
        current.insertBefore(match, existing ?? null);
        existing = match;
      } else {
        current.insertBefore(desired.cloneNode(true), existing ?? null);
        index += 1;
        continue;
      }
    }
    patchNode(existing, desired, preserveFormValues);
    index += 1;
  }
  while (current.childNodes.length > index) current.lastChild.remove();
}

export function updateHtml(root, html, { preserveFormValues = false } = {}) {
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = html;
  patchChildren(root, template.content, preserveFormValues);
}
