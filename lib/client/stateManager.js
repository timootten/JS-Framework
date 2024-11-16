let stateCount = 0;

let states = new Map();

function state(initialValue) {
  const stateNumber = stateCount;
  stateCount++;
  states.set(stateNumber, initialValue);
  return new Proxy(
    {},
    {
      set(target, key, value) {
        if (key === "value") {
          console.log("Changed to:", value);
          states.set(stateNumber, value);
          updateStateUI(stateNumber, value);
        }
        return true;
      },
      get(target, prop, receiver) {
        console.log("GET");
        return states.get(stateNumber);
      },
    }
  );
}

function updateStateUI(stateNumber) {
  const state = statePaths.find(statePath => statePath.stateNumber === stateNumber);

  state.paths.forEach((path) => {
    console.log(path)

    let element = document.evaluate(
      "/html/body" + path.location,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    ).singleNodeValue;
    if (element) {
      element.innerText = path.value.replace(
        /{(\d+|[a-zA-Z_]\w*)}/g,
        function (match, name) {
          return states.get(getStateNumberByName(name));
        }
      );
    }
  });
}

function getStateNameByStateNumber(stateNumber) {
  return statePaths.find((state) => state.stateNumber === stateNumber).name;
}

function getStateNumberByName(name) {
  return statePaths.find((state) => state.stateName === name).stateNumber;
}