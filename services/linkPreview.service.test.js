const assert = require("node:assert/strict");
const { test } = require("node:test");
const { _internal } = require("./linkPreview.service");
const { isPrivateIp, normalizeInputUrl, extractMetadata, domainOf } = _internal;

test("private and reserved IPv4 ranges are refused, public ones are not", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true, "loopback");
  assert.equal(isPrivateIp("10.0.0.5"), true, "RFC1918");
  assert.equal(isPrivateIp("172.16.0.1"), true, "RFC1918");
  assert.equal(isPrivateIp("172.31.255.255"), true, "RFC1918 upper bound");
  assert.equal(isPrivateIp("172.32.0.1"), false, "just outside the RFC1918 block");
  assert.equal(isPrivateIp("192.168.1.1"), true, "RFC1918");
  assert.equal(isPrivateIp("169.254.169.254"), true, "link-local — the cloud metadata address");
  assert.equal(isPrivateIp("100.64.0.1"), true, "carrier-grade NAT");
  assert.equal(isPrivateIp("8.8.8.8"), false, "public");
  assert.equal(isPrivateIp("142.250.190.14"), false, "public");
});

test("private IPv6 ranges are refused, including v4-mapped private addresses", () => {
  assert.equal(isPrivateIp("::1"), true, "loopback");
  assert.equal(isPrivateIp("fe80::1"), true, "link-local");
  assert.equal(isPrivateIp("fc00::1"), true, "unique local");
  assert.equal(isPrivateIp("fd12:3456::1"), true, "unique local");
  assert.equal(isPrivateIp("::ffff:10.0.0.1"), true, "v4-mapped private address");
  assert.equal(isPrivateIp("2001:4860:4860::8888"), false, "public (Google DNS)");
});

test("a non-IP string is treated as unsafe rather than guessed at", () => {
  assert.equal(isPrivateIp("not-an-ip"), true);
});

test("input URLs are normalised to http(s) only, and malformed input is rejected", () => {
  assert.equal(normalizeInputUrl("https://example.com/page?q=1"), "https://example.com/page?q=1");
  assert.equal(normalizeInputUrl("  https://example.com  "), "https://example.com/");
  assert.equal(normalizeInputUrl("ftp://example.com/file"), null, "non-http(s) scheme");
  assert.equal(normalizeInputUrl("javascript:alert(1)"), null, "no scheme-confusable payload");
  assert.equal(normalizeInputUrl("not a url"), null);
  assert.equal(normalizeInputUrl(""), null);
  assert.equal(normalizeInputUrl(null), null);
});

test("domainOf strips a leading www. and tolerates a bad URL", () => {
  assert.equal(domainOf("https://www.example.com/a/b"), "example.com");
  assert.equal(domainOf("https://shop.example.com/a"), "shop.example.com");
  assert.equal(domainOf("nope"), null);
});

test("metadata extraction prefers Open Graph, falls back through Twitter Card to plain HTML", () => {
  const html = `<html><head>
    <title>Plain title</title>
    <meta name="description" content="Plain description">
    <meta property="og:title" content="OG title">
    <meta property="og:description" content="OG description">
    <meta property="og:image" content="/img/hero.jpg">
    <meta property="og:site_name" content="Example Site">
    <link rel="icon" sizes="32x32" href="/favicon-32.png">
    <link rel="icon" sizes="16x16" href="/favicon-16.png">
  </head><body></body></html>`;
  const meta = extractMetadata(html, "https://example.com/article");
  assert.equal(meta.title, "OG title");
  assert.equal(meta.description, "OG description");
  assert.equal(meta.image, "https://example.com/img/hero.jpg", "relative image URL resolved against the page");
  assert.equal(meta.siteName, "Example Site");
  assert.equal(meta.favicon, "https://example.com/favicon-32.png", "the larger declared icon wins");
});

test("metadata extraction falls back to plain <title> and a guessed favicon.ico when nothing else is published", () => {
  const html = `<html><head><title>Just a title</title></head><body></body></html>`;
  const meta = extractMetadata(html, "https://bare.example.com/page");
  assert.equal(meta.title, "Just a title");
  assert.equal(meta.description, null);
  assert.equal(meta.image, null);
  assert.equal(meta.favicon, "https://bare.example.com/favicon.ico");
});

test("a page with nothing at all yields every field null (favicon still guesses /favicon.ico)", () => {
  const meta = extractMetadata("<html><head></head><body>hi</body></html>", "https://empty.example.com");
  assert.deepEqual(meta, {
    title: null,
    description: null,
    image: null,
    favicon: "https://empty.example.com/favicon.ico",
    siteName: null,
  });
});

test("long title and description text is clipped, not left to blow up a card", () => {
  const long = "x".repeat(1000);
  const html = `<html><head><meta property="og:title" content="${long}"><meta property="og:description" content="${long}"></head></html>`;
  const meta = extractMetadata(html, "https://example.com");
  assert.ok(meta.title.length <= 300);
  assert.ok(meta.description.length <= 500);
  assert.ok(meta.title.endsWith("…"));
});
