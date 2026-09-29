"use strict";

/**
 * CMS-wide semantic catalogue compiler.
 *
 * Feature modules declare business domains and metrics once. The compiler owns
 * normalization, longest-unique alias resolution, domain detection, catalogue
 * validation and model-candidate filtering. Database access remains in the
 * feature adapter; this module contains no persistence or permissions.
 */

const catalogues = new Map();

const normalize = (value) => String(value || "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const includesTerm = (text, term) => {
  const haystack = ` ${normalize(text)} `;
  const needle = normalize(term);
  return Boolean(needle && haystack.includes(` ${needle} `));
};

function longestUnique(definitions, text, termsFor) {
  const matches = [];
  for (const definition of definitions) {
    for (const term of termsFor(definition)) {
      const normalized = normalize(term);
      if (normalized && includesTerm(text, normalized)) {
        matches.push({ definition, length: normalized.length, term: normalized });
      }
    }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.length - a.length);
  const longest = matches[0].length;
  const winners = [...new Map(matches
    .filter((match) => match.length === longest)
    .map((match) => [match.definition.id, match.definition])).values()];
  return winners.length === 1 ? winners[0] : null;
}

function compileSemanticCatalogue({ id, domains = [], metrics = [], entities = [] } = {}) {
  if (!id || typeof id !== "string") throw new Error("semantic catalogue id is required");
  const domainById = new Map();
  const metricById = new Map();
  const entityById = new Map();

  for (const domain of domains) {
    if (!domain || !domain.id || domainById.has(domain.id)) throw new Error(`invalid or duplicate domain in ${id}`);
    domainById.set(domain.id, Object.freeze({ ...domain, aliases: Object.freeze([...(domain.aliases || [])]) }));
  }
  for (const entity of entities) {
    if (!entity || !entity.id || entityById.has(entity.id)) throw new Error(`invalid or duplicate entity in ${id}`);
    entityById.set(entity.id, Object.freeze({ ...entity, aliases: Object.freeze([...(entity.aliases || [])]) }));
  }
  for (const metric of metrics) {
    if (!metric || !metric.id || metricById.has(metric.id)) throw new Error(`invalid or duplicate metric in ${id}`);
    if (metric.domain && !domainById.has(metric.domain)) throw new Error(`unknown domain ${metric.domain} for ${metric.id}`);
    if (metric.entity && !entityById.has(metric.entity)) throw new Error(`unknown entity ${metric.entity} for ${metric.id}`);
    metricById.set(metric.id, Object.freeze({ ...metric, aliases: Object.freeze([...(metric.aliases || [])]) }));
  }

  const compiled = Object.freeze({
    id,
    domains: Object.freeze(Object.fromEntries(domainById)),
    entities: Object.freeze(Object.fromEntries(entityById)),
    metrics: Object.freeze(Object.fromEntries(metricById)),
    resolveMetric(text) {
      return longestUnique([...metricById.values()], text, (definition) => [definition.label, ...(definition.aliases || [])]);
    },
    detectDomains(text) {
      return [...domainById.values()]
        .filter((domain) => [domain.label, ...(domain.aliases || [])].some((term) => includesTerm(text, term)))
        .map((domain) => domain.id);
    },
    stripMetricTerms(text, definition) {
      let output = String(text || "");
      if (!definition) return output.trim();
      const terms = [definition.label, ...(definition.aliases || [])]
        .filter(Boolean).sort((a, b) => b.length - a.length);
      for (const term of terms) {
        const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        output = output.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
      }
      return output.replace(/\s+/g, " ").trim();
    },
    audit() {
      const issues = [];
      const aliases = new Map();
      for (const metric of metricById.values()) {
        const terms = [metric.label, ...(metric.aliases || [])];
        if (!terms.some((term) => normalize(term))) issues.push({ type: "metric_without_terms", id: metric.id });
        for (const term of terms) {
          const key = normalize(term);
          if (!key) continue;
          const owners = aliases.get(key) || new Set();
          owners.add(metric.id);
          aliases.set(key, owners);
        }
      }
      for (const [term, owners] of aliases) {
        if (owners.size > 1) issues.push({ type: "ambiguous_metric_alias", term, owners: [...owners].sort() });
      }
      return { ok: issues.length === 0, issues, domainCount: domainById.size, entityCount: entityById.size, metricCount: metricById.size };
    },
  });
  catalogues.set(id, compiled);
  return compiled;
}

function semanticToolCandidates(tools, text) {
  const selectable = (tools || []).filter((tool) => tool.modelSelectable !== false);
  const detectedByCatalogue = new Map();
  for (const catalogue of catalogues.values()) {
    const detected = catalogue.detectDomains(text);
    if (detected.length) detectedByCatalogue.set(catalogue.id, new Set(detected));
  }
  if (detectedByCatalogue.size) {
    const candidates = selectable.filter((tool) => {
      const semantic = tool.semantic;
      if (!semantic || !detectedByCatalogue.has(semantic.catalogue)) return false;
      const detected = detectedByCatalogue.get(semantic.catalogue);
      return (semantic.domains || []).some((domain) => detected.has(domain));
    });
    if (candidates.length) return candidates;
  }
  const relevant = selectable.filter((tool) => {
    try { return tool.matches(text) === true; } catch { return false; }
  });
  return relevant.length ? relevant : selectable;
}

function detectSemanticDomains(text) {
  const detected = {};
  for (const catalogue of catalogues.values()) {
    const domains = catalogue.detectDomains(text);
    if (domains.length) detected[catalogue.id] = domains;
  }
  return detected;
}

const getSemanticCatalogue = (id) => catalogues.get(id) || null;
const clearSemanticCatalogues = () => catalogues.clear();

module.exports = {
  normalize,
  includesTerm,
  compileSemanticCatalogue,
  semanticToolCandidates,
  detectSemanticDomains,
  getSemanticCatalogue,
  _clearSemanticCatalogues: clearSemanticCatalogues,
};
