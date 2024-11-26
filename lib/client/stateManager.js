let stateCount = 0;
let states = new Map();

function state(initialValue) {
  const id = stateCount;
  stateCount++;
  states.set(id, initialValue);

  const x = ["sdsd"];

  console.log("State Number: ", id);

  const name = statePaths.find((state) => state.id === id).name;
  console.log(name);

  // Create a proxy handler for reactive object properties
  const handler = {
    get(target, prop, receiver) {
      console.log("Get property:", prop);
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'object' && value !== null) {
        return new Proxy(value, handler);
      }
      return value;
    },
    set(target, prop, value, receiver) {
      console.log(`Property '${prop}' changed to:`, value);
      const result = Reflect.set(target, prop, value, receiver);

      // Update the global states map if necessary
      states.set(id, target);
      updateStateUI(id, prop);
      return result;
    }
  };

  const proxiedValue = (typeof initialValue === 'object' && initialValue !== null)
    ? new Proxy(initialValue, handler)
    : initialValue;

  const isProxied = typeof initialValue === 'object' && initialValue !== null;

  Object.defineProperty(window, name, {
    get() {
      console.log("Get: ", name);
      if (isProxied) return proxiedValue;
      return states.get(id);
    },
    set(value) {
      console.log("Changed to: ", value);
      const updatedValue = (typeof value === 'object' && value !== null)
        ? new Proxy(value, handler)
        : value;
      states.set(id, updatedValue);
      updateStateUI(id);
    }
  });

  return proxiedValue;
}

function legacy_state(initialValue) {
  const id = stateCount;
  stateCount++;
  states.set(id, initialValue);
  return new Proxy(
    {},
    {
      set(target, key, value) {
        if (key === "value") {
          console.log("Changed to:", value);
          states.set(id, value);
          updateStateUI(id, value);
        }
        return true;
      },
      get(target, prop, receiver) {
        console.log("GET");
        return states.get(id);
      },
    }
  );
}

function updateStateUI(id, changedProperty) {
  const state = statePaths.find(statePath => statePath.id === id);

  const replacePlaceholder = (value) => {
    return value.replace(/{(\w+(\.\w+|\['\w+'\])?)}/g, (match, name) => {
      const [state, ...properties] = name.split(/\.|\['|'\]/).filter(Boolean);
      let stateObj = states.get(getidByName(state));
      properties.forEach(prop => {
        stateObj = stateObj?.[prop];
      });
      return stateObj;
    });
  };

  state.paths.forEach((path) => {
    const pathProperty = path.value.match(/{(\w+(\.\w+|\['\w+'\])?)}/)[1].split(/\.|\['|'\]/).filter(Boolean)[1];
    if (changedProperty && pathProperty !== changedProperty) return;

    let element = document.evaluate(
      "/html/body" + path.location,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    ).singleNodeValue;
    if (!element) return;
    if (path.type === "TEXT") {
      console.log("Text: ", path.value);
      element.innerText = replacePlaceholder(path.value);
    }
    if (path.type === "ATTRIBUTE") {
      if (path.attributeName === "value") {
        element.value = replacePlaceholder(path.value);
      } else {
        element.setAttribute(path.attributeName, replacePlaceholder(path.value));
      }
    }
  });
}

function getidByName(name) {
  return statePaths.find((state) => state.name === name).id;
}