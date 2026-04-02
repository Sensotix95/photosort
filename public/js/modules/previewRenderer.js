// Renders the folder tree preview in the DOM.

import { buildFolderTree } from './planBuilder.js';

export function renderPreview(plan, container) {
  const tree   = buildFolderTree(plan);
  const total  = plan.length;

  container.innerHTML = '';

  const header = document.createElement('p');
  header.className = 'preview-summary';
  header.textContent = `${total} files will be organised into the following structure:`;
  container.appendChild(header);

  const root = document.createElement('ul');
  root.className = 'folder-tree';
  renderNode(tree, root, 0);
  container.appendChild(root);
}

function renderNode(node, ul, depth) {
  const keys = Object.keys(node).filter(k => k !== '_count').sort();

  for (const key of keys) {
    const child = node[key];
    const li    = document.createElement('li');
    li.className = 'tree-node';

    const count = countLeaves(child);
    const label = document.createElement('span');
    label.className = 'folder-label';

    const icon   = depth === 0 ? '📁' : depth === 1 ? '📂' : '  ';
    label.innerHTML = `${icon} <strong>${escHtml(key)}</strong> <span class="file-count">${count} file${count !== 1 ? 's' : ''}</span>`;

    li.appendChild(label);

    const subKeys = Object.keys(child).filter(k => k !== '_count');
    if (subKeys.length > 0) {
      const nested = document.createElement('ul');
      renderNode(child, nested, depth + 1);
      li.appendChild(nested);
      // Make folder collapsible
      label.style.cursor = 'pointer';
      label.addEventListener('click', () => {
        nested.style.display = nested.style.display === 'none' ? '' : 'none';
      });
    }

    ul.appendChild(li);
  }
}

function countLeaves(node) {
  let total = node._count || 0;
  for (const key of Object.keys(node)) {
    if (key !== '_count') total += countLeaves(node[key]);
  }
  return total;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
