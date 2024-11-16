
import * as acorn from 'acorn';
import { tsPlugin } from 'acorn-typescript';


const node = acorn.Parser.parse(`
const a = 1
let b = 2

function c() {
  const d = 3
}

let count = stat2e(0);

function state() {
  // abc
}
`, {
  sourceType: 'module',
  ecmaVersion: 'latest',
  locations: true
})

console.log(JSON.stringify(node))