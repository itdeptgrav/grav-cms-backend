// utils/lazyGoogleapis.js
//
// `googleapis` takes 1.7 s to load warm and ~38 s cold, and 22 files required
// it at the top, so every server start paid for it before listening — even
// though nothing calls Google until somebody uploads a file or reads a mail
// (17 Oct 2026, owner: "the dev server should start instantly"). This stands
// in for `require("googleapis")`: `google` is loaded the first time any
// property of it is touched, and then behaves exactly like the real one.
"use strict";

let real = null;
const load = () => (real || (real = require("googleapis").google));

const google = new Proxy({}, {
  get(_t, prop) {
    const g = load();
    const v = g[prop];
    return typeof v === "function" && !/^[A-Z]/.test(String(prop)) ? v.bind(g) : v;
  },
  has(_t, prop) { return prop in load(); },
  ownKeys() { return Reflect.ownKeys(load()); },
  getOwnPropertyDescriptor(_t, prop) { const d = Object.getOwnPropertyDescriptor(load(), prop); if (d) d.configurable = true; return d; },
});

module.exports = { google };
