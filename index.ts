import { makeLiveReloadMiddleware } from "./liveReload";
import { join } from "path";
import { existsSync } from "fs";
import { parse, HTMLElement } from 'node-html-parser';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { getXPath, parseObjectExpression } from "./utils";
import { generate } from "astring";

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

  const escapeString = (str: string): string => {
    return str.replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  };

  const statePathsString = JSON.stringify(statePaths, (key, value) => {
    if (typeof value === 'string') {
      return escapeString(value);
    }
    return value;
  });

  const statesPathScript = `
    <script>
      const statePaths = JSON.parse('${statePathsString}');
    </script>
    `;

  return statesPathScript + dom.toString();
};

function updateUIStates2(dom: HTMLElement, paths: Path[], states: State[]) {

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const element = getElementByXPath(dom, path.location);
    if (!element) continue;
    const jsContents = extractPlaceholders(path.value);

    const results: any[] = [];

    for (let i = 0; i < jsContents.length; i++) {
      const jsContent = jsContents[i];
      const executableJS = replacePlaceholder(jsContent, states);
      const result = eval(executableJS);
      results.push(result);
    }

    const value = replacePlaceholdersWithArrayValues(path.value, results);

    if (path.type === "TEXT") {
      element.textContent = value || '';
    } else if (path.type === "ATTRIBUTE") {
      element.setAttribute(path.attributeName, value || '');
    }
  }
}

function replacePlaceholdersWithArrayValues(content: string, values: any[]): string | undefined {
  let index = 0;
  return content.replace(/{[^{}]+}/g, () => {
    if (index < values.length) {
      const value = values[index++];
      return value !== undefined ? value : '';
    }
    return '';
  });
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

const replacePlaceholder = (value: string, states: State[]): string => {
  const ast = acorn.parse(value, { ecmaVersion: 2020, sourceType: 'module' });


  walk.ancestor(ast, {
    Identifier(node, _, ancestors) {
      const state = states.find(s => s.name === node.name);
      if (state) {


        const properties: string[] = [];

        for (let i = ancestors.length - 2; i >= 0; i--) {
          const ancestor = ancestors[i];
          if (ancestor.type !== "MemberExpression") break;
          const value = (ancestor as any).property.name;
          if (value)
            properties.push(value);
        }


        let value = state.value;
        for (let i = 0; i < properties.length; i++) {
          const property = properties[i];
          value = value[property];
        }

        (node as any).raw = JSON.stringify(value);
        (node as any).value = properties.length;
        (node as any).type = 'Literal';
      }
    },
    MemberExpression(node, state, ancestors) {
      if (node.type === "MemberExpression") {
        let propertyCount = 1;

        //check if node.check is a member expression if so add 1 to property count and check again in a loop until it is a literal and then console log the raw from the literal
        let currentNode = node;
        while (currentNode.object.type === "MemberExpression") {
          propertyCount++;
          currentNode = currentNode.object;
        }

        if (currentNode.object.type !== "Literal" || currentNode.object?.value !== propertyCount) return;

        let value = currentNode.object?.raw;

        (node as any).type = 'Literal';
        (node as any).value = value;
        (node as any).raw = value;
        (node as any).object = undefined;
        (node as any).property = undefined;
      }
    }
  });

  return generate(ast);
};


function getStatePaths(dom: HTMLElement, states: State[]): StatePath[] {
  const elements = dom.querySelectorAll('*')
    .filter(element => element.tagName !== 'SCRIPT')
    .filter((element) => {
      let containsState = false;

      // Check text content
      element.childNodes.forEach(child => {
        if (child.nodeType === 3 && child.textContent?.match(/{[^{}]+}/g)) {
          containsState = true;
        }
      });

      // Check attributes
      if (!containsState) {
        for (const attrName in element.attributes) {
          if (element.attributes[attrName].match(/{[^{}]+}/g)) {
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
    const textMatches = textValue.match(/{[^{}]+}/g);

    if (textMatches) {
      for (let j = 0; j < textMatches.length; j++) {
        const match = textMatches[j];
        const stateNames = extractStateNames(match.slice(1, -1)); // Remove the curly braces and extract state names

        let validStateFound = false;
        stateNames.forEach(stateName => {
          const state = stateName.split(/\.|\['|'\]/)[0];
          const stateIndex = states.findIndex(s => s.name === state);
          if (stateIndex !== -1) {
            validStateFound = true;
            let statePath = statePaths.find(sp => sp.name === state);
            if (!statePath) {
              statePath = {
                id: stateIndex,
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
        });

        if (!validStateFound) {
          let statePath = statePaths.find(sp => sp.name === 'NONE');
          if (!statePath) {
            statePath = {
              id: -1,
              name: 'NONE',
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
    }

    // Check for attributes containing the state placeholder
    for (const attrName in element.attributes) {
      const attrValue = element.attributes[attrName];
      const attrMatches = attrValue.match(/{[^{}]+}/g);
      if (attrMatches) {
        for (let j = 0; j < attrMatches.length; j++) {
          const match = attrMatches[j];
          const stateNames = extractStateNames(match.slice(1, -1)); // Remove the curly braces and extract state names

          let validStateFound = false;
          stateNames.forEach(stateName => {
            const state = stateName.split(/\.|\['|'\]/)[0];
            const stateIndex = states.findIndex(s => s.name === state);
            if (stateIndex !== -1) {
              validStateFound = true;
              let statePath = statePaths.find(sp => sp.name === state);
              if (!statePath) {
                statePath = {
                  id: stateIndex,
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
          });

          if (!validStateFound) {
            let statePath = statePaths.find(sp => sp.name === 'NONE');
            if (!statePath) {
              statePath = {
                id: -1,
                name: 'NONE',
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
  }

  return statePaths;
}

function extractStateNames(content: string): string[] {
  const regex = /\b\w+\b/g;
  const matches = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    matches.push(match[0]);
  }
  return matches.length > 0 ? matches : ['NONE'];
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