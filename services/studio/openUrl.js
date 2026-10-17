// services/studio/openUrl.js
//
// The address that opens GRAV Studio on a style: `gravstudio://sample/<id>`.
// The installer registers the `gravstudio` scheme for the signed-in user; a
// browser without the app does nothing with it, and the linked file still
// waits on Studio's start screen. `api` tells the app which CMS made the link,
// so a designer signed in to another one is told rather than shown nothing.

"use strict";

const API_PUBLIC_URL = () => (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/+$/, "");

function openUrlFor(style) {
  const id = encodeURIComponent(String(style?._id || ""));
  return `gravstudio://sample/${id}?api=${encodeURIComponent(API_PUBLIC_URL())}`;
}

module.exports = { openUrlFor, API_PUBLIC_URL };
