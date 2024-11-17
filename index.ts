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

const updateHTMLFile = (html: string) => {

  let dom = parse(html);

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

  const statePaths: {
    stateNumber: number
    stateName: string
    paths: ({
      location: string
      type: "TEXT"
      value: string
    } | {
      location: string
      type: "ATTRIBUTE"
      attributeName: string
      value: string
    })[]
  }[] = []



  states.forEach(state => {
    const statePlaceholder = `{${state.name}}`;
    const elements = dom.querySelectorAll('*')
      .filter(element => element.tagName !== 'SCRIPT')
      .filter((element) => {
        let containsState = false;

        // Check text content
        element.childNodes.forEach(child => {
          if (child.nodeType === 3 && child.textContent?.match(/{\w+(\.\w+|\['\w+'\])?}/)) {
            containsState = true;
          }
        });

        // Check attributes
        if (!containsState) {
          for (const attrName in element.attributes) {
            if (element.attributes[attrName].match(/{\w+(\.\w+|\['\w+'\])?}/)) {
              containsState = true;
              break;
            }
          }
        }

        return containsState;
      });

    elements.forEach(element => {
      const location = getXPath(element);

      // Check for text content containing the state placeholder
      const textValue = element.innerHTML;
      const textMatches = textValue.match(/{\w+(\.\w+|\['\w+'\])?}/g);

      if (textMatches) {
        textMatches.forEach(match => {
          const stateName = match.slice(1, -1); // Remove the curly braces
          const [state, property] = stateName.split(/\.|\['|'\]/).filter(Boolean);
          let statePath = statePaths.find(sp => sp.stateName === state);
          if (!statePath) {
            statePath = {
              stateNumber: states.findIndex(s => s.name === state),
              stateName: state,
              paths: []
            };
            statePaths.push(statePath);
          }
          const existingPath = statePath.paths.find(p => p.location === location && p.type === "TEXT");
          if (!existingPath) {
            statePath.paths.push({ location, value: textValue, type: "TEXT" });
          }
        });
      }

      // Check for attributes containing the state placeholder
      for (const attrName in element.attributes) {
        const attrValue = element.attributes[attrName];
        const attrMatches = attrValue.match(/{\w+(\.\w+|\['\w+'\])?}/g);
        if (attrMatches) {
          attrMatches.forEach(match => {
            const stateName = match.slice(1, -1); // Remove the curly braces
            const [state, property] = stateName.split(/\.|\['|'\]/).filter(Boolean);
            let statePath = statePaths.find(sp => sp.stateName === state);
            if (!statePath) {
              statePath = {
                stateNumber: states.findIndex(s => s.name === state),
                stateName: state,
                paths: []
              };
              statePaths.push(statePath);
            }
            const existingPath = statePath.paths.find(p => p.location === location && p.type === "ATTRIBUTE" && p.attributeName === attrName);
            if (!existingPath) {
              statePath.paths.push({ location, value: attrValue, type: "ATTRIBUTE", attributeName: attrName });
            }
          });
        }
      }
    });
  });

  console.log(statePaths.find(sp => sp.stateName === 'hello'));

  const statesPathScript = `
  <script>
    const statePaths = JSON.parse('${JSON.stringify(statePaths)}');
  </script>
  `;

  states.forEach(state => {
    updateStateUI(state.name);
  });


  function updateStateUI(stateName: string) {
    const state = statePaths.find(statePath => statePath.stateName === stateName)!;

    state.paths.forEach((path) => {
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
        return value.replace(/{(\w+(\.\w+|\['\w+'\])?)}/g, (match, name) => {
          const [state, property] = name.split(/\.|\['|'\]/).filter(Boolean);
          const stateObj = states.find(s => s.name === state)?.value;
          return property ? stateObj?.[property] : stateObj;
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

  return statesPathScript + dom.toString();
};


const requestHandler = liveReload(async (req) => {
  return router(req);
});

Bun.serve({ port: 3000, fetch: requestHandler });