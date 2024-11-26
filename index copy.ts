import { makeLiveReloadMiddleware } from "./liveReload";
import { join } from "path";
import { existsSync } from "fs";
import { parse, HTMLElement } from 'node-html-parser';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { getXPath, parseObjectExpression } from "./utils";

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

type State = {
  id: number;
  name: string;
  value: any;
};

type StatePath = {
  id: number
  name: string
  paths: Path[]
}

type Path = {
  location: string
  type: "TEXT"
  value: string
} | {
  location: string
  type: "ATTRIBUTE"
  attributeName: string
  value: string
}

const updateHTMLFile = (html: string) => {

  let dom = parse(html);

  const scripts = dom.querySelectorAll('script').map((script) => script.innerHTML).join('\n');

  const ast = acorn.parse(scripts, { ecmaVersion: 2020, sourceType: 'module' });

  let states: State[] = [];

  let stateCount = 0;

  walk.ancestor(ast, {
    VariableDeclarator(node) {
      if (node.init &&
        node.init.type === 'CallExpression' &&
        node.init.callee.type === 'Identifier' &&
        node.init.callee.name === 'state' &&
        node.id.type === "Identifier"
      ) {
        if (node.init.arguments[0].type === 'Literal') {
          const variableName = node.id.name;
          const variableValue = node.init.arguments[0].value;
          states.push({ id: stateCount, name: variableName, value: variableValue });
          stateCount++;
        } else if (node.init.arguments[0].type === 'ObjectExpression') {
          const variableName = node.id.name;
          const variableValue = parseObjectExpression(node);
          states.push({ id: stateCount, name: variableName, value: variableValue });
          stateCount++;
        }
      }
    }
  });

  const statePaths: StatePath[] = getStatePaths(dom, states);

  const uniquePaths = new Set<string>();
  const uniqueStatePaths = [];

  for (let i = 0; i < statePaths.length; i++) {
    const sp = statePaths[i];
    for (let j = 0; j < sp.paths.length; j++) {
      const path = sp.paths[j];
      const key = `${path.location}-${path.type}-${path.type === "ATTRIBUTE" ? path.attributeName : ''}`;
      if (!uniquePaths.has(key)) {
        uniquePaths.add(key);
        uniqueStatePaths.push(path);
      }
    }
  }

  updateUIStates2(dom, uniqueStatePaths, states);



  const statesPathScript = `
    <script>
      const statePaths = JSON.parse('${JSON.stringify(statePaths)}');
    </script>
    `;

  return statesPathScript + dom.toString();
};

function updateUIStates2(dom: HTMLElement, paths: Path[], states: State[]) {
  console.log(paths);

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const element = getElementByXPath(dom, path.location);
    if (!element) continue;
    const jsContent = extractPlaceholders(path.value);
    console.log(jsContent)
  }
}

function extractPlaceholders(content: string): string[] {
  const regex = /{([^{}]+)}/g;
  const matches = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    matches.push(match[1].trim());
  }
  return matches;
}

const replacePlaceholder = (value: string, states: State[]) => {
  return value.replace(/{(\w+(?:\.\w+|\['\w+'\])*)}/g, (match, name: string) => {
    const [state, ...properties] = name.split(/\.|\['|'\]/).filter(Boolean);
    let stateObj = states.find(s => s.name === state)?.value;
    properties.forEach(prop => {
      stateObj = stateObj?.[prop];
    });
    return stateObj;
  });
};


function getStatePaths(dom: HTMLElement, states: State[]): StatePath[] {
  const elements = dom.querySelectorAll('*')
    .filter(element => element.tagName !== 'SCRIPT')
    .filter((element) => {
      let containsState = false;

      // Check text content
      element.childNodes.forEach(child => {
        if (child.nodeType === 3 && child.textContent?.match(/{\w+(?:\.\w+|\['\w+'\])*}/g)) {
          containsState = true;
        }
      });

      // Check attributes
      if (!containsState) {
        for (const attrName in element.attributes) {
          if (element.attributes[attrName].match(/{\w+(?:\.\w+|\['\w+'\])*}/g)) {
            containsState = true;
            break;
          }
        }
      }

      return containsState;
    });

  const statePaths: StatePath[] = [];

  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    const location = getXPath(element);

    // Check for text content containing the state placeholder
    const textValue = element.innerHTML;
    const textMatches = textValue.match(/{\w+(?:\.\w+|\['\w+'\])*}/g);

    if (textMatches) {
      for (let j = 0; j < textMatches.length; j++) {
        const match = textMatches[j];
        const stateName = match.slice(1, -1); // Remove the curly braces
        const state = stateName.split(/\.|\['|'\]/)[0];
        let statePath = statePaths.find(sp => sp.name === state);
        if (!statePath) {
          statePath = {
            id: states.findIndex(s => s.name === state),
            name: state,
            paths: []
          };
          statePaths.push(statePath);
        }
        const existingPath = statePath.paths.find(p => p.location === location && p.type === "TEXT");
        if (!existingPath) {
          statePath.paths.push({ location, value: textValue, type: "TEXT" });
        }
      }
    }

    // Check for attributes containing the state placeholder
    for (const attrName in element.attributes) {
      const attrValue = element.attributes[attrName];
      const attrMatches = attrValue.match(/{\w+(?:\.\w+|\['\w+'\])*}/g);
      if (attrMatches) {
        for (let j = 0; j < attrMatches.length; j++) {
          const match = attrMatches[j];
          const stateName = match.slice(1, -1); // Remove the curly braces
          const state = stateName.split(/\.|\['|'\]/)[0];
          let statePath = statePaths.find(sp => sp.name === state);
          if (!statePath) {
            statePath = {
              id: states.findIndex(s => s.name === state),
              name: state,
              paths: []
            };
            statePaths.push(statePath);
          }
          const existingPath = statePath.paths.find(p => p.location === location && p.type === "ATTRIBUTE" && p.attributeName === attrName);
          if (!existingPath) {
            statePath.paths.push({ location, value: attrValue, type: "ATTRIBUTE", attributeName: attrName });
          }
        }
      }
    }
  }

  return statePaths;
}

const getElementByXPath = (dom: HTMLElement, xPath: string) => {
  // Convert the XPath to a CSS selector
  const cssSelector = xPath
    .replace(/\[([0-9]+)\]/g, ':nth-of-type($1)')
    .replace(/\//g, ' > ')
    .replace(/^ > /, '')
    .replace(/html > body > /, ''); // Remove leading html > body if present

  // Find the element using the CSS selector
  let element = dom.querySelector(cssSelector);

  return element;
};

function updateUIStates(dom: HTMLElement, paths: Path[], states: State[]) {
  paths.forEach((path) => {
    // Convert the XPath to a CSS selector
    const cssSelector = path.location
      .replace(/\[([0-9]+)\]/g, ':nth-of-type($1)')
      .replace(/\//g, ' > ')
      .replace(/^ > /, '')
      .replace(/html > body > /, ''); // Remove leading html > body if present

    // Find the element using the CSS selector
    let element = dom.querySelector(cssSelector);
    if (!element) return;

    const replacePlaceholder = (value: string) => {
      return value.replace(/{(\w+(?:\.\w+|\['\w+'\])*)}/g, (match, name: string) => {
        const [state, ...properties] = name.split(/\.|\['|'\]/).filter(Boolean);
        let stateObj = states.find(s => s.name === state)?.value;
        properties.forEach(prop => {
          stateObj = stateObj?.[prop];
        });
        return stateObj;
      });
    };

    if (path.type === "TEXT") {
      if (element instanceof HTMLElement) {
        element.textContent = replacePlaceholder(path.value);
      }
    }

    if (path.type === "ATTRIBUTE") {
      if (element instanceof HTMLElement) {
        element.setAttribute(path.attributeName, replacePlaceholder(path.value));
      }
    }
  });
}

const requestHandler = liveReload(async (req) => {
  return router(req);
});

Bun.serve({ port: 3000, fetch: requestHandler });