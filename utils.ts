
import { HTMLElement } from 'node-html-parser';
import type { VariableDeclarator, ObjectExpression } from 'acorn';

export function getXPath(node: HTMLElement | null): string {
  if (!node) {
    throw new Error("Invalid node provided.");
  }

  let path: string = '';

  // Traverse up the tree until the root node
  while (node) {
    // Determine the index of the current node among its siblings with the same tag and content
    let index = 1;

    const parent = node.parentNode;
    if (parent) {
      const children = parent.childNodes.filter(child => child instanceof HTMLElement && child.tagName === node?.tagName);
      for (let i = 0; i < children.length; i++) {
        const sibling = children[i] as HTMLElement;
        if (sibling === node) {
          break;
        }
        index++;
      }
    }

    // Construct the current node's XPath part
    const nodeXPath = node.tagName ? `${node.tagName.toLowerCase()}[${index}]` : '';

    // Prepend the current node's XPath to the full path
    path = nodeXPath + (path ? '/' + path : '');

    // Move to the parent node
    node = node.parentNode && (node.parentNode as HTMLElement).tagName ? (node.parentNode as HTMLElement) : null;
  }

  return `/${path}`;
}

export function parseObjectExpression(node: VariableDeclarator): any {
  if (!node || !node.init) return null;
  if (node.init.type !== 'CallExpression' || node.init.arguments[0].type !== 'ObjectExpression') {
    throw new Error('Node is not an ObjectExpression');
  }

  function parseObject(node: ObjectExpression): any {
    const obj: any = {};

    node.properties.forEach(prop => {
      if (prop.type !== 'Property') {
        return;
      }
      const key = (prop.key.type === 'Identifier') ? prop.key.name : null;
      let value;
      if (prop.value.type === 'Literal') {
        value = prop.value.value;
      } else if (prop.value.type === 'ObjectExpression') {
        value = parseObject(prop.value);
      }
      if (key !== null) {
        obj[key] = value;
      }
    });

    return obj;
  }

  return parseObject(node.init.arguments[0] as ObjectExpression);
}