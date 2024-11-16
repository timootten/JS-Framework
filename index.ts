import { makeLiveReloadMiddleware } from "./liveReload";
import { join } from "path";
import { existsSync } from "fs";
import { parse } from 'node-html-parser';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { HTMLElement } from 'node-html-parser';

const liveReload = makeLiveReloadMiddleware({ watchdirs: ['./'] });

const router = async (req: Request) => {
  const url = new URL(req.url);
  let filePath = '';

  if (url.pathname === '/') {
    filePath = 'index.html';
  } else if (url.pathname.startsWith('/lib/client')) {
    filePath = join('.', url.pathname);
  } else {
    return new Response('File not found', { status: 404 });
  }

  if (!existsSync(filePath)) {
    return new Response('File not found', { status: 404 });
  }

  try {
    let fileContent = await Bun.file(filePath).text();
    const contentType = filePath.endsWith('.html') ? 'text/html' :
      filePath.endsWith('.js') ? 'application/javascript' :
        filePath.endsWith('.css') ? 'text/css' : 'text/plain';



    if (contentType === 'text/html') {
      fileContent = updateHTMLFile(fileContent);
    }

    return new Response(fileContent, {
      headers: {
        'Content-Type': contentType,
      },
    });
  } catch (error) {
    console.error(`Error reading file: ${filePath}`, error);
    return new Response('File not found', { status: 404 });
  }
};

const updateHTMLFile = (html: string) => {

  const dom = parse(html);

  const scripts = dom.querySelectorAll('script').map((script) => script.innerHTML).join('\n');

  const ast = acorn.parse(scripts, { ecmaVersion: 2020, sourceType: 'module' });

  let states: {
    id: number;
    name: string;
    value: any;
  }[] = []

  let stateCount = 0;

  walk.ancestor(ast, {
    VariableDeclarator(node) {
      if (node.init && node.init.type === 'CallExpression' &&
        node.init.callee.type === 'Identifier' && node.init.callee.name === 'state') {
        if (node.init.arguments[0].type === 'Literal' && node.id.type === "Identifier") {
          const variableName = node.id.name;
          const variableValue = node.init.arguments[0].value;
          states.push({ id: stateCount, name: variableName, value: variableValue });
          stateCount++;
        }
      }
    }
  });

  //console.log(states)

  const statePaths: {
    stateNumber: number
    stateName: string
    paths: {
      location: string
      value: string
    }[]
  }[] = []

  // Find all the paths with the dom that are using the states and their values
  // example: <span>Count1: {count1}</span>
  /* goes to this: 
   {
    stateNumber: 0
    stateName: "count1"
    paths: {
      location: "/html/body/span[1]"
      value: "Count1: {0}"
    }
  */
  states.forEach(state => {
    const statePlaceholder = `{${state.name}}`;
    const elements = dom.querySelectorAll('*')
      .filter(element => element.tagName !== 'SCRIPT')
      .filter((element) => {
        let containsState = false;
        element.childNodes.forEach(child => {
          if (child.nodeType === 3 && child.textContent?.includes(statePlaceholder)) {
            containsState = true;
          }
        });
        return containsState;
      });


    elements.forEach(element => {
      const location = getXPath(element);

      const value = element.innerHTML;

      let statePath = statePaths.find(sp => sp.stateNumber === state.id);
      if (!statePath) {
        statePath = {
          stateNumber: state.id,
          stateName: state.name,
          paths: []
        };
        statePaths.push(statePath);
      }

      statePath.paths.push({ location, value });
    });
  });

  console.log();

  const statesPathScript = `
  <script>
    const statePaths = JSON.parse('${JSON.stringify(statePaths)}');

    console.log(statePaths);
  </script>
  `;

  return statesPathScript + dom.toString();
};


function getXPath(node: HTMLElement | null): string {
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


const requestHandler = liveReload(async (req) => {
  return router(req);
});

Bun.serve({ port: 3000, fetch: requestHandler });