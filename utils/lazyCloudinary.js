// utils/lazyCloudinary.js
//
// `cloudinary` pulls in ~240 files (most of them lodash) and two modules
// required it at the top, so every server start paid for it before listening
// although nothing calls Cloudinary until somebody uploads or deletes a legacy
// image (17 Oct 2026, owner: "the dev server should start instantly"). This
// stands in for `require("cloudinary").v2`: the SDK is loaded and configured
// from the environment the first time any property is touched, and then
// behaves exactly like the real one — the same config both callers used to set
// at load.
"use strict";

let real = null;
const load = () => {
  if (real) return real;
  real = require("cloudinary").v2;
  real.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  return real;
};

const cloudinary = new Proxy({}, {
  get(_t, prop) {
    const c = load();
    const v = c[prop];
    return typeof v === "function" && !/^[A-Z]/.test(String(prop)) ? v.bind(c) : v;
  },
  has(_t, prop) { return prop in load(); },
  ownKeys() { return Reflect.ownKeys(load()); },
  getOwnPropertyDescriptor(_t, prop) { const d = Object.getOwnPropertyDescriptor(load(), prop); if (d) d.configurable = true; return d; },
});

module.exports = { cloudinary };
