"use strict";
/**
 * services/ai/storeCommandSearch.service.js — Cmd/Ctrl K, answered deterministically.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
 * The command palette must answer "stock of macbook", "where is sodium kept"
 * and "GRN/2026-27/0004" without a language model. Those are not conversation;
 * they are a catalogue lookup and an identity resolution, and the Store
 * assistant already does both deterministically.
 *
 * ── NO MODEL ON THIS PATH ─────────────────────────────────────────────────
 * This module does not require `gravAssistant`, `qwenToolPlanner`, the Ollama
 * client or any other model surface, and a test asserts the whole require
 * graph from here contains none of them. The answer comes from exactly three
 * things a tool already owns:
 *
 *   claim({user, message})      — does this tool recognise this request, by
 *                                 catalogue alias and real record identity?
 *   provideContext({...})       — read the authorised value.
 *   renderAnswer({...})         — say it in words, server-side.
 *
 * `claim` is the gate. A tool that does not claim is not run, so an
 * uninterpretable phrase produces an unsupported state rather than a broad
 * collection read. That is the difference between a palette and a query box.
 *
 * ── AND WHY IT REUSES THE TOOLS RATHER THAN QUERYING MONGO ────────────────
 * Every permission check, tenant scope, field projection and trusted link
 * already lives in the tools. A second path to the same data would be a second
 * place for those to be wrong, and the two would drift.
 */

const { authorizedTools, getTool } = require("./toolRegistry");
const { compileIntent, INTENT, singularForms } = require("./storeCommandIntent");
const { includesTerm, getSemanticCatalogue } = require("./semanticCatalogue");
const {
  selectCandidates, groupBySubject, recognises, recognisedLength, MAX_CANDIDATES,
} = require("./storeCommandRouting");
const { recogniseAnyEntity, resolveEntity } = require("../storePurchaseUniversalContext");
const { ENTITY_SPECS } = require("../storePurchaseUniversalContract");

/** The families the catalogue-wide pass skips, read from the contract. */
const COLLECTION_ONLY = Object.freeze(
  ENTITY_SPECS.filter((spec) => spec.collectionOnly).map((spec) => spec.id),
);
const { claimFromIntent } = require("./storeCommandArgs");
const { menuFor, validate, sentenceFor } = require("./storeCommandRouterContract");
const { withCards } = require("./storeRecordCards");
const { sanitizeAssistantLinks, storeRecordHref } = require("./assistantLinks");
const { closestMatches, approximateNote } = require("./commandSearch/closest");

/**
 * Which families hold a record by these words — ALL of them.
 *
 * The catalogue-wide pass leaves the collection-only families out, so those
 * are asked directly by the same `resolveEntity` under the same tenant scope.
 *
 * ── ALWAYS BOTH, NEVER ONE INSTEAD OF THE OTHER ──────────────────────────
 * The direct read used to run only when the pass named nothing. A supplier's
 * name is also written on every purchase order raised against it
 * (`vendorName` is a purchase-order identity field), so "DIBANKSH
 * ENTERPRISES" was found by the pass as a PURCHASE ORDER, the pass had named
 * something, the supplier master was never asked, and the person who typed a
 * vendor's name was shown one of its orders. Any family that records another
 * family's name masks it that way, so the two reads now always run together:
 * one pass, plus one read per collection-only family, side by side.
 *
 * Returns the family ids that found a record, and the collection-only
 * resolutions themselves — `{entity, recordId, label}`, ids and labels only —
 * because no capability resolves those families BY NAME, so nothing
 * downstream could rediscover them.
 */
async function familiesHolding(actor, message) {
  const [matches, direct] = await Promise.all([
    /* `cached`: the identity space is kept for a short while, so a person
       typing a name pays for the 53 reads once, not once per keystroke. See
       `identityRows` in the universal context for what that costs. */
    Promise.resolve(recogniseAnyEntity({ user: actor, message, cached: true })).catch(() => []),
    Promise.all(COLLECTION_ONLY.map(async (entity) => {
      try {
        const found = await resolveEntity({
          entity, user: actor, message, includeRecord: false, cached: true,
        });
        return found?.found ? found : null;
      } catch {
        return null;
      }
    })),
  ]);
  const records = direct.filter(Boolean);
  const named = [...new Set([
    ...(matches || []).filter((match) => match?.resolution?.found).map((match) => match.entity),
    ...records.map((record) => record.entity),
  ])];
  return { named, records };
}
const { resolveAppAccess } = require("../access/appAccess.service");
const storeTenant = require("../storePurchase/tenantContext.service");

/* Loading the tool modules registers them. Required here so this service is
   self-sufficient: an endpoint that forgot one would silently answer less. */
require("./tools/storeTools");
require("./tools/inventoryTools");
require("./tools/storeCollectionTools");
require("./tools/storeOperationalTools");
require("./tools/storePurchaseTools");
require("./tools/storePurchaseCollectionTools");
require("./tools/storePurchaseUniversalTools");
require("./tools/storeRequestDeskTools");

/* ── BOTH FAMILIES ARE STORE & PURCHASE ───────────────────────────────────
   The registry tags 7 capabilities `store` and 110 `store_purchase`. Filtering
   on `"store"` alone excluded inventory stock and locations, the Request Desk,
   receiving, procurement, operational summaries and every universal field —
   110 of 117. They are one application to the person using it, and two
   internal families only because they were built at different times.

   Including both does NOT widen access. Three gates still apply, and all
   three must pass:
     1  the verified Store application grant, with its read capability;
     2  the Store & Purchase read capability, from the tenant resolver;
     3  the tool's own `permission(user)`, applied by `authorizedTools`.
   A `store_purchase` capability is therefore unreachable by somebody who
   does not hold Store itself. */
const APPLICATIONS = Object.freeze(["store", "store_purchase"]);
const APPLICATION = "store";
const MAX_QUERY = 200;
const MAX_ROWS = 20;
/** How many claiming capabilities are read for one question. */
const MAX_ANSWERS = 3;

/** What a result can be. Closed, and mirrored by the browser's validator. */
const RESULT_KIND = Object.freeze({
  RECORD: "record",
  FACT: "fact",
  COLLECTION: "collection",
  CHOICE: "choice",
  SAFE_ACTION: "safe_action",
});

/**
 * The authority this request runs under.
 *
 * The same two resolvers `gravAssistant.ensureAccess` uses — deliberately
 * called directly rather than through it, so the deterministic path never
 * loads the model module. Only Store is resolved, because only Store is
 * served here.
 *
 * Fails CLOSED: an actor whose access cannot be resolved holds none.
 */
async function resolveStoreActor(user) {
  const actor = { ...user };
  if (actor.applicationAccess === undefined) actor.applicationAccess = {};
  if (actor.applicationAccess[APPLICATION] === undefined) {
    try {
      actor.applicationAccess[APPLICATION] = await resolveAppAccess(actor, APPLICATION);
    } catch {
      actor.applicationAccess[APPLICATION] = { allowed: false, capabilities: {} };
    }
  }
  if (actor.storePurchaseAccess === undefined) {
    try {
      actor.storePurchaseAccess = await storeTenant.resolveForActor(actor);
    } catch {
      actor.storePurchaseAccess = { capabilities: [], capabilitySet: new Set(), companyId: null };
    }
  }
  return actor;
}

/**
 * Does this person hold Store at all?
 *
 * The floor under both families. A `store_purchase` capability's own check
 * asks only for the purchase read capability, which somebody could hold
 * through another route; this requires the Store application grant as well,
 * so the palette can never reach further than the Store UI does.
 */
function hasStoreApplicationAccess(actor) {
  const grant = actor?.applicationAccess?.[APPLICATION];
  return Boolean(grant?.allowed && grant.capabilities?.read);
}

/** Is this request inside a resolved company? */
function tenantOf(actor) {
  return actor?.storePurchaseAccess?.companyId || null;
}

/**
 * The Store & Purchase capabilities this person may use.
 *
 * `authorizedTools` has already applied each tool's own `permission(user)`.
 * What is added here is the application floor: both families, and neither
 * without Store.
 */
function storeToolsFor(actor) {
  if (!hasStoreApplicationAccess(actor)) return [];
  return authorizedTools(actor).filter((tool) => APPLICATIONS.includes(tool.application));
}

const text = (v, max = 300) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Stage two: ask only the routed candidates.
 *
 * ── WHY NOT ALL OF THEM ───────────────────────────────────────────────────
 * This used to loop every authorised tool and call `claim` on each. `claim`
 * resolves real record identities, which means database reads — so with both
 * families included that is up to 117 reads for one keystroke. The palette
 * would have been slower than the chat it replaces.
 *
 * So `selectCandidates` narrows first, reading nothing but what each tool
 * declares about itself, and only the survivors are asked. The set is bounded
 * and the same every time the same question is asked.
 *
 * ── ONE IDENTITY READ PER SUBJECT ─────────────────────────────────────────
 * Capabilities that share a subject resolve the same record. They are grouped
 * so that happens once and the result is shared, rather than four readers of
 * a purchase order each fetching it.
 */
async function claimsFor(actor, message, { signal } = {}) {
  const intent = compileIntent(message);
  if (!intent.ok) return { claims: [], intent, candidates: 0, tools: [], identityReads: 0 };

  const tools = storeToolsFor(actor);
  let candidates = selectCandidates(tools, intent);
  const claims = [];
  let identityReads = 0;
  /* The entity families a business reference in this question resolved to. */
  const identified = new Set();

  /* ── A NUMBER NOBODY SAID THE KIND OF ───────────────────────────────────
     "GRN/2026-27/0004" routes because "GRN" is a goods receipt's own alias.
     "CSM-2026-0004", "REQ-2610-0001" and every SKU do not: their prefixes
     name no entity, so the words matched nothing and a person typing the
     number on the document in front of them was told no record matched.

     The catalogue can answer this itself. `recogniseAnyEntity` asks which
     families hold a record with that identity, scoped to this actor, and
     the family it names is then routed to by the ordinary rule, as though
     the person had said the word.

     ── WHAT IT COSTS, SAID PLAINLY ───────────────────────────────────
     It is the assistant's own catalogue pass: an identity read per family,
     cached for five seconds per actor and message. That is the most
     expensive thing on this path, so it runs ONLY when the question
     carries a reference AND no capability's own aliases recognised the
     words — "GRN/2026-27/0004" never reaches it, because "GRN" is a goods
     receipt's own alias. After it, selection is bounded as always. */
  /* ── AND A BARE NAME NOBODY'S VOCABULARY RECOGNISED ────────────────────
     "Lining Polyster Plain" names a material, and no capability's declared
     words match any of it — so every identity-resolving capability scored
     exactly the same, and which six were asked came down to REGISTRATION
     ORDER. Loading the full registry (as the server does, through the
     assistant) reordered them, and the three asked were a supplier reader,
     a unit reader and a warehouse reader. None could find a material, so a
     material that was sitting in the catalogue came back "no authorised
     Store record matches that".

     The suites never saw it: they load the Store modules only, and that
     order happened to put the inventory readers first. A product whose
     answer depends on which file was required first is not deterministic,
     whatever the tests say.

     So when nothing in the question matched any capability's own
     vocabulary, the catalogue is asked which family actually HOLDS a
     record by that name — the same one pass the reference case uses — and
     that family's capabilities are the ones asked. */
  const nothingRecognised = !candidates.some((tool) => recognises(tool, intent.raw));
  /* ── AND ONLY AFTER THE CHEAP ROUTE HAS BEEN TRIED ────────────────────
       For a bare NAME the routed capabilities are asked first, by
       `search`, and the catalogue pass is reached only if none of them
       found the record — see `lookUpFamily` below. A REFERENCE comes
       here directly, because there is no cheaper way to learn which
       family issued a number nobody's vocabulary recognises. */
  if (Boolean(intent.reference) && nothingRecognised) {
    try {
      identityReads += 1;
      /* ── THE TWO FAMILIES THAT PASS EXCLUDES ───────────────────────────
         `isImplicitlyRecognisable` leaves the COLLECTION-ONLY families out
         of the catalogue-wide pass — today that is the raw-item master and
         the supplier master. The reason is sound for the assistant, which
         addresses them as collections; it is wrong for a search box, where
         typing a SKU or a supplier code is the most ordinary thing anybody
         does. `familiesHolding` asks them directly, alongside the pass. */
      const { named } = await familiesHolding(actor, message);
      if (named.length) {
        /* ── ONLY A REFERENCE SETTLES THE KIND ─────────────────────────
             A resolved REFERENCE means the question named one record and
             the family is no longer in doubt, so its capabilities may
             answer without their own words matching.

             A bare NAME is different: the lookup only says which family
             to ASK. Letting a collection capability claim on that basis
             turned "macbook" into "more than one recorded inventory item
             matches that wording" — the collection reader's refusal —
             where the identity resolver picks the exact record and offers
             it. So for a name the lookup re-routes and nothing more. */
        if (intent.reference) for (const id of named) identified.add(id);
        /* ── THE FAMILY IT BELONGS TO COMES FIRST ────────────────────
             Adding the family's words to the question is not enough on
             its own: "goods receipt" scores the DISPOSITION, INSPECTION,
             PUTAWAY and SESSION capabilities just as highly, and each of
             those resolves a named field rather than a record, so a bare
             GRN number filled all six candidate places with capabilities
             that could not answer it.

             So the capabilities whose own subject IS the resolved family
             lead, and among those the ones that read a RECORD rather than
             a named field — a reference asks "show me this", not "tell me
             this field of it". The ordinary selection then fills whatever
             places are left, and the set is bounded as before. */
        const owns = (tool) => (tool.semantic?.subjects || []).some((id) => identified.has(id));
        const exact = tools.filter(owns);
        const ordered = [
          ...exact.filter((tool) => typeof tool.claim !== "function"),
          ...exact.filter((tool) => typeof tool.claim === "function"),
          ...selectCandidates(tools, {
            ...intent,
            terms: [...(intent.terms || []), ...named.flatMap((id) => id.split("_"))],
          }),
        ];
        candidates = [...new Set(ordered)].slice(0, MAX_CANDIDATES);
      }
    } catch {
      /* The reference could not be placed; the ordinary candidates stand. */
    }
  }

  /* ── SIDE BY SIDE, NOT ONE AFTER ANOTHER ─────────────────────────────
     The subjects are independent, and so are the capabilities within one:
     none reads what another claimed. Asking them in turn made a bare name
     pay for every slow claim in sequence — the legacy Store reader alone
     spends a quarter of a second deciding it does not recognise a material.
     The set is bounded at MAX_CANDIDATES before this point, so running it
     at once reads exactly what running it in turn read; only the waiting
     changes. Order is kept: claims come back in the order routing ranked. */
  const groups = signal?.aborted ? [] : groupBySubject(candidates);
  const perGroup = await Promise.all(groups.map(async ({ tools: group }) => {
    /* ── CLAIM FIRST, RESOLVE AFTER ───────────────────────────────────
       Nearly every capability's `claim` is pure — it reads the catalogue
       alias, not the database. Resolving the subject before asking would
       pay for a record read on a subject nothing wants. So the cheap
       question is asked first, and identity is resolved once, lazily, only
       for a subject something claimed. */
    const asked = await Promise.all(group.map(async (tool) => {
      try {
        /* A capability with no `claim` is a COLLECTION capability: it
           answers plural, counted, filtered and dated questions and
           expects its arguments to be chosen for it. The grammar fills
           them from the capability's own declared vocabulary; a form that
           cannot be filled is a capability that has not claimed. */
        const ownsReference = (tool.semantic?.subjects || []).some((id) => identified.has(id));
        const claim = typeof tool.claim === "function"
          ? await tool.claim({ user: actor, message, history: [] })
          : claimFromIntent(tool, intent, message, { identified: ownsReference });
        return claim ? { tool, args: claim } : null;
      } catch {
        /* A capability that throws while deciding has not claimed. Failing
           closed keeps one broken reader from taking the palette down. */
        return null;
      }
    }));
    const claimed = asked.filter(Boolean);
    if (!claimed.length) return [];

    /* ── ONE IDENTITY READ PER SUBJECT ────────────────────────────────
         The capabilities in this group resolve the same record. Four
         readers of a purchase order asking for it separately is three
         reads of the same document. */
    let subject = null;
    const resolver = claimed.find(({ tool }) => typeof tool.recognizeSubject === "function");
    if (resolver && !signal?.aborted) {
      try {
        identityReads += 1;
        subject = await resolver.tool.recognizeSubject({ user: actor, message, history: [] });
      } catch {
        subject = null;
      }
    }
    return claimed.map((entry) => ({ ...entry, subject, intent }));
  }));
  for (const entries of perGroup) claims.push(...entries);
  return {
    claims, intent, candidates: candidates.length, tools: candidates, identityReads,
    /* So the caller can widen AFTER the cheap attempt, instead of paying
       for the catalogue pass on every bare name. */
    nothingRecognised,
  };
}

/**
 * Which family holds a record by this name, and that family's capabilities.
 *
 * The expensive path, reached only when the routed capabilities found
 * nothing: an identity read per family, cached per actor and message. It
 * exists because WHICH capabilities get routed to a bare name is decided by
 * declared vocabulary, and a material's name matches none of it.
 */
async function lookUpFamily(actor, message, intent) {
  const tools = storeToolsFor(actor);
  try {
    const { named, records } = await familiesHolding(actor, message);
    if (!named.length) return { candidates: [], records: [] };
    const owns = (tool) => (tool.semantic?.subjects || []).some((id) => named.includes(id));
    const exact = tools.filter(owns);
    return {
      candidates: [...new Set([
        ...exact.filter((tool) => typeof tool.recognizeSubject === "function"),
        ...selectCandidates(tools, {
          ...intent,
          terms: [...(intent.terms || []), ...named.flatMap((id) => id.split("_"))],
        }),
      ])].slice(0, MAX_CANDIDATES),
      records,
    };
  } catch {
    return { candidates: [], records: [] };
  }
}

/**
 * A collection-only record found by name, as a row the person can open.
 *
 * ── WHY THESE NEED THEIR OWN ROW ──────────────────────────────────────────
 * `discover` turns a capability's own `recognizeSubject` into rows, and no
 * capability recognises a supplier master or raw-item master record BY NAME
 * under that family's id — the supplier reader's subject is "supplier", the
 * inventory readers' "inventory_item". So a vendor the lookup had found came
 * back "no authorised Store record matches that": the family was known, the
 * record was known, and nothing was allowed to say so.
 *
 * The identity is `resolveEntity`'s — tenant-scoped, ids and labels only —
 * and the link is the OWNING capability's own `buildLinks`, asked with the
 * navigation shape it emits for its own list rows. So the row exists only
 * when an authorised capability of that family offers somewhere to open it:
 * the person's permission is the tool's, never this function's.
 */
function recordRows(tools, records) {
  const rows = [];
  for (const record of records) {
    const recordId = text(record?.recordId, 100);
    const label = text(record?.label, 160);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(recordId) || !label) continue;
    const owners = tools.filter((tool) => (
      (tool.semantic?.subjects || []).includes(record.entity) && typeof tool.buildLinks === "function"
    ));
    for (const tool of owners) {
      let links = [];
      try {
        links = sanitizeAssistantLinks(tool.buildLinks({
          data: { navigation: [{ entity: record.entity, recordId, label }] },
          args: {},
          message: label,
        }));
      } catch {
        links = [];
      }
      if (!links[0]?.href) continue;
      rows.push({
        id: `record:${tool.name}:${recordId}`,
        kind: RESULT_KIND.RECORD,
        title: label,
        subtitle: text(links[0].label, 200),
        href: links[0].href,
        entityType: record.entity,
        metadata: { tool: tool.name, recordId, single: true },
      });
      break;
    }
  }
  return rows;
}

/**
 * Turn one tool's reading into palette results.
 *
 * `renderAnswer` is the tool's own sentence — the same words the assistant
 * would have given, produced without a model. `buildLinks` and `buildChoices`
 * are the tool's own, and both are re-sanitised here even though the tools
 * sanitise: this is the boundary that faces the browser.
 */
async function runClaim(actor, message, { tool, args, subject }) {
  /* `recognizedSubject` is the identity already resolved for this subject
     group. Omitting it is what made every answer resolve the same record
     twice — once to decide the capability, once to read it. */
  const data = await tool.provideContext({
    user: actor, args, message, history: [], recognizedSubject: subject || undefined,
  });
  const answer = tool.renderAnswer
    ? tool.renderAnswer({ data, args, message, user: actor })
    : null;

  const links = sanitizeAssistantLinks(
    tool.buildLinks ? tool.buildLinks({ data, args, message, user: actor }) : [],
  );
  const rawChoices = tool.buildChoices
    ? tool.buildChoices({ data, args, message, user: actor })
    : [];

  /* ── A CHOICE CARRIES A CANONICAL IDENTITY, NEVER A LABEL ───────────
     The first version put the display text into the resolution, appended it
     to the original question and searched again. That is not identity
     resolution — it is a second guess at the same ambiguous words, and a
     record whose name is a substring of another's could never be chosen.

     A choice now carries only what the server can verify on the way back:
     the capability, the concept and the canonical record id. The label is
     for the person to read and is never sent anywhere. */
  const choices = (Array.isArray(rawChoices) ? rawChoices : [])
    .map((choice, i) => {
      const label = text(choice?.label || choice?.text || choice, 160);
      const recordId = text(choice?.recordId || choice?.id || choice?.value, 100);
      if (!label) return null;
      /* Without a canonical id there is nothing to resolve BY, and resolving
         by the label is the defect. Such a choice is not offered. */
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(recordId)) return null;
      return {
        id: `choice:${tool.name}:${recordId}`,
        kind: RESULT_KIND.CHOICE,
        title: label,
        subtitle: "Select to answer for this record",
        resolve: {
          tool: tool.name,
          concept: args?.metric || null,
          entityType: text(choice?.entity || args?.entity, 80) || null,
          recordId,
        },
      };
    })
    .filter(Boolean)
    .slice(0, MAX_ROWS);

  if (choices.length) return { kind: "choices", results: choices, data };

  if (!answer) return { kind: "unsupported", results: [], data };
  /* ── A REFUSAL IS NOT AN ANSWER BECAUSE IT IS A SENTENCE ─────────────
     A capability that found no record still renders one — "I couldn't
     match one customer account exactly" — and the palette reported it as
     `answered`, beside a green state, for a reference nobody had issued.
     `resolveChoice` already read the resolution's own verdict first; this
     path now does too. An AMBIGUOUS resolution is different: it found
     several, and its sentence asking which one is worth showing. */
  if (notFound(data) && !ambiguous(data)) return { kind: "unsupported", results: [], data };
  /* The same for a collection reader that REFUSED: `ok: false` with its
     reason ("I couldn't safely match the requested purchase order
     constraint…") is the reader declining, not answering. It was reported
     `answered`. The reason is kept — it is the most useful sentence there is
     — and shown as the refusal it is. */
  if (data && data.ok === false) return { kind: "refused", results: [], data, reason: text(answer, 300) };

  const [primary] = links;
  /* About ONE record — a reference, a named item, a single match — so its
     link is that record's, and it may carry that record's card. The first
     link of a list is not the list's summary. */
  const single = (Array.isArray(data?.navigation) && data.navigation.length === 1)
    || ["item", "resolution", "supplier", "subject"].some((key) => data?.[key]?.found === true);
  return {
    kind: "answer",
    data,
    results: [{
      id: `fact:${tool.name}:${args?.metric || "value"}`,
      /* A reading WITH a record link is a record result; without one it is a
         fact. The difference is whether there is somewhere to open. */
      kind: primary ? RESULT_KIND.RECORD : RESULT_KIND.FACT,
      title: text(answer, 300),
      /* The concept in words ("purchase order status"), never its id: the
         palette showed "__records__" and "sp.purchase_order.ponumber" under
         answers, which is the database talking to the person. */
      subtitle: conceptLabel(tool, args?.metric),
      value: text(answer, 300),
      href: primary?.href || null,
      entityType: text(args?.metric || "", 80) || null,
      metadata: { tool: tool.name, concept: args?.metric || null, single: Boolean(primary && single) },
    },
    /* Every other trusted link the tool offered, as its own openable row. */
    ...links.slice(1).map((link, i) => ({
      id: `link:${tool.name}:${i}`,
      kind: RESULT_KIND.RECORD,
      title: text(link.label, 200),
      href: link.href,
    }))],
  };
}

/**
 * Did the capability fail to find the record it was asked for?
 *
 * Every Store resolver reports itself the same way — `{found, ambiguous}` —
 * under `item` for the inventory family and `resolution` for the universal
 * one. An explicit `found: false` is a failed read whatever sentence came
 * with it. A capability that reports nothing either way is taken at its
 * word, because many answer about a company rather than a record.
 */
function notFound(data) {
  for (const key of ["item", "resolution", "subject"]) {
    const part = data?.[key];
    if (part && typeof part === "object" && part.found === false) return true;
  }
  return false;
}

/** The longest of a capability's own family names that this question contains. */
function matchedLabel(tool, message) {
  const forms = singularForms(message);
  return (tool.semantic?.labels || [])
    .map((label) => String(label || "").trim())
    .filter((label) => label && forms.some((form) => includesTerm(form, label)))
    .sort((a, b) => b.length - a.length)[0] || "";
}

/**
 * The longest name of the CONCEPT a claim was made for, as the question says it.
 *
 * Read from the capability's own vocabulary: its `x-semanticOptions`, or the
 * semantic catalogue it declares. Nothing here keeps a list of phrases.
 */
function conceptPhrase(claim, message) {
  const metric = claim?.args?.metric;
  if (!metric) return "";
  const option = claim.tool?.parameters?.properties?.metric?.["x-semanticOptions"]?.[metric];
  const definition = option || getSemanticCatalogue(claim.tool?.semantic?.catalogue)?.metrics?.[metric];
  if (!definition) return "";
  const forms = singularForms(message);
  return [definition.label, ...(definition.aliases || [])]
    .map((term) => String(term || "").trim())
    .filter((term) => term && forms.some((form) => includesTerm(form, term)))
    .sort((a, b) => b.length - a.length)[0] || "";
}

function longestConceptPhrase(claims, message) {
  return claims.map((claim) => conceptPhrase(claim, message))
    .sort((a, b) => b.length - a.length)[0] || "";
}

/** A concept's human label, from the capability's own vocabulary, or null. */
function conceptLabel(tool, metric) {
  if (!metric || /^__/.test(metric)) return null;
  const option = tool?.parameters?.properties?.metric?.["x-semanticOptions"]?.[metric];
  const definition = option || getSemanticCatalogue(tool?.semantic?.catalogue)?.metrics?.[metric];
  return text(definition?.label, 200) || null;
}

/** Did it find several, rather than none? */
function ambiguous(data) {
  return ["item", "resolution", "subject"].some((key) => data?.[key]?.ambiguous === true);
}

/**
 * A bare name, with no figure asked for.
 *
 * ── WHY THIS IS NOT A CLAIM ───────────────────────────────────────────────
 * Typing "macbook" asks no question. Every capability answers a named figure
 * and so none of them claims it, which left the most ordinary thing anybody
 * does with a palette — type a name and open the record — answering "no
 * authorised Store record matches that" about a material that was sitting
 * right there.
 *
 * So a discovery result is not an answer; it is the record itself. The
 * identity comes from the capability's own `recognizeSubject` and the link
 * from its own `buildLinks`, so nothing here guesses a route or a field: a
 * row appears only when an authorised capability both found the record and
 * offered somewhere to open it.
 */
async function discover(actor, message, candidates, { signal } = {}) {
  const results = [];
  const seen = new Set();

  /* The resolvers are independent reads; asked side by side, a name costs
     the slowest of them rather than their sum. The rows are still taken in
     the order routing ranked the capabilities. */
  const askable = signal?.aborted ? [] : candidates.slice(0, MAX_ANSWERS)
    .filter((tool) => typeof tool.recognizeSubject === "function");
  const resolutions = await Promise.all(askable.map((tool) => (
    Promise.resolve()
      .then(() => tool.recognizeSubject({ user: actor, message, history: [] }))
      .catch(() => null)
  )));

  for (const [index, tool] of askable.entries()) {
    const resolution = resolutions[index];
    if (!resolution) continue;
    /* One exact record, or the several an ambiguous name could mean — both
       are rows to choose between, and neither is a figure. */
    const found = resolution?.found ? [resolution.record || resolution] : [];
    const rows = found.length ? found : (resolution?.matches || []);

    for (const row of rows) {
      const recordId = text(row?._id || row?.recordId, 100);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(recordId) || seen.has(recordId)) continue;
      const label = text(row?.name || row?.label || row?.sku, 160);
      if (!label) continue;
      /* The capability's own link builder, given its own resolver's shape.
         Both families are handed what each reads, and the one that does not
         recognise the shape simply offers nothing. */
      let links = [];
      try {
        links = sanitizeAssistantLinks(tool.buildLinks ? tool.buildLinks({
          data: {
            item: { found: true, record: row },
            resolution: { found: true, recordId, label, entity: tool.semantic?.subjects?.[0] },
          },
          args: {},
          message,
          user: actor,
        }) : []);
      } catch {
        links = [];
      }
      /* A row with nowhere to open is not a search result, it is a rumour. */
      if (!links[0]?.href) continue;
      seen.add(recordId);
      results.push({
        id: `record:${tool.name}:${recordId}`,
        kind: RESULT_KIND.RECORD,
        title: row?.sku && row?.name && row.sku !== row.name ? `${label} (${text(row.sku, 60)})` : label,
        subtitle: text(links[0].label, 200),
        href: links[0].href,
        entityType: text(tool.semantic?.subjects?.[0] || "", 80) || null,
        metadata: { tool: tool.name, recordId, single: true },
      });
    }
  }
  return results.slice(0, MAX_ROWS);
}

/**
 * THE ENTRY POINT.
 *
 * Returns `{ groups, state }`. `state` is one of:
 *   answered      — a tool claimed and read a value
 *   choices       — several authorised records match; the person picks
 *   no_match      — capabilities were asked and none recognised the record.
 *   unsupported   — the grammar placed nothing, so nothing was asked. NOT an
 *                   error, and NOT a broad query: the honest answer that this
 *                   phrasing has no proven deterministic meaning here.
 *   needs_clarification — a constraint was understood but could not be
 *                   attached to a business date, and is never silently dropped.
 *   unauthorised  — this person may not read Store, or holds no company.
 */
/**
 * Ask an optional router to translate words the grammar could not place.
 *
 * `router` is injected by the caller — this module never loads a model, and
 * with no router (the default, and every test of the deterministic path)
 * nothing here runs. See `storeCommandRouterContract` for what the router is
 * shown and what its choice must survive. Every failure — down, slow, wrong,
 * a name not on the menu, a value the person never typed, a sentence that
 * still answers nothing — is the refusal the person would have had anyway.
 *
 * ── ATTRIBUTABLE ──────────────────────────────────────────────────────────
 * A routed answer says how the words were read, and every row carries
 * `via: "router"`, so a wrong answer can be traced to the translation rather
 * than to the data.
 */
async function routeUnplaced({ actor, message, intent, router, signal }) {
  if (typeof router !== "function" || signal?.aborted) return null;
  const menu = menuFor(storeToolsFor(actor), message);
  if (!menu.families.length && !menu.concepts.length) return null;
  let choice;
  try {
    choice = await router({ message, menu, signal });
  } catch {
    return null;
  }
  const sentence = sentenceFor(validate(choice, menu, message), intent || {});
  if (!sentence || sentence.toLowerCase() === message.toLowerCase()) return null;
  /* No router on the second pass: one translation, never a chain of them. */
  const out = await search({ user: actor, query: sentence, signal });
  if (!["answered", "choices"].includes(out.state)) return null;
  return {
    ...out,
    note: `Read as "${text(sentence, 160)}".`,
    routed: { from: message, sentence },
    groups: (out.groups || []).map((group) => ({
      ...group,
      results: group.results.map((row) => ({
        ...row,
        metadata: { ...(row.metadata || {}), via: "router", readAs: sentence },
      })),
    })),
  };
}

/* ── NOTHING EXACT: THE CLOSEST, WITH A WARNING ────────────────────────────
   Owner's call, 9 Oct 2026 — "we can't do verbatim; show the best possible
   results while giving a small warning". When the exact search finds nothing
   for what reads as a NAME ("Feed Off Arm"), the records whose names come
   closest — over the same company-scoped identity rows the exact search
   reads — are offered under a note saying they are not an exact match. Never
   for a document number, a filter or a date window: near misses are not the
   answer to a narrower question (services/ai/commandSearch/closest.js). */
async function search(args = {}) {
  const out = await searchExact(args);
  if (!["no_match", "unsupported"].includes(out.state)) return out;
  const message = text(args.query, MAX_QUERY);
  const intent = compileIntent(message);
  if (!message || intent.reference || intent.constraint || intent.dateRange) return out;
  const near = await closestRecords(args.user, message).catch(() => []);
  if (!near.length) return out;
  return { state: "answered", note: approximateNote(message), groups: [{ label: "Closest matches", results: near }] };
}

async function closestRecords(user, message) {
  const actor = await resolveStoreActor(user);
  if (!storeToolsFor(actor).length || !tenantOf(actor)) return [];
  const { ENTITY_SPECS } = require("../storePurchaseUniversalContract"); // eslint-disable-line global-require
  const universal = require("../storePurchaseUniversalContext"); // eslint-disable-line global-require
  const candidates = [];
  await Promise.all(ENTITY_SPECS.filter((spec) => !spec.singleton).map(async (spec) => {
    const scope = universal.scopeFor(spec, actor);
    if (scope === null) return;
    const rows = await universal.identityRows(spec, scope, { cached: true }).catch(() => []);
    for (const row of rows) {
      const values = universal.identityValues(spec, row);
      if (values.length) candidates.push({ label: values[0], words: values.join(" "), spec, row, values });
    }
  }));
  const near = closestMatches(message, candidates, { limit: 5 });
  const results = near.map(({ candidate: c }, i) => {
    const href = sanitizeAssistantLinks([{ href: storeRecordHref(c.spec.id, c.row._id) || "", label: c.label }])[0]?.href || null;
    return {
      id: `near:${c.spec.id}:${c.row._id}`,
      kind: href ? "record" : "fact",
      title: text(c.label, 200),
      subtitle: text([cap(c.spec.label), ...c.values.slice(1, 2)].filter(Boolean).join(" · "), 200),
      href,
      entityType: c.spec.id,
      /* The closest one carries its card, so the person sees whether it is
         the one they meant without opening it. */
      metadata: { single: i === 0, approximate: true, record: { entity: c.spec.id, recordId: String(c.row._id) } },
    };
  });
  return withCards(actor, results);
}
const cap = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());

async function searchExact({ user, query, signal, router } = {}) {
  const message = text(query, MAX_QUERY);
  if (!message) return { state: "unsupported", groups: [] };

  const actor = await resolveStoreActor(user);
  if (!storeToolsFor(actor).length) return { state: "unauthorised", groups: [] };
  if (!tenantOf(actor)) return { state: "unauthorised", groups: [] };

  const {
    claims, intent, candidates, tools, nothingRecognised,
  } = await claimsFor(actor, message, { signal });

  /* ── A CONSTRAINT IS NEVER DROPPED ────────────────────────────────────
     "in June 2026" with no business date named is a filter nothing can
     honour: a goods receipt has a receipt date, an expected date, an
     invoice date and an inspection date, and the window means a different
     answer against each. Running the rest and returning everything would
     answer a question nobody asked, confidently.

     This fires whether the capability refused the form (it has no date it
     can attach the window to) or claimed and would have dropped it. Both
     are the same thing to the person: say which date you mean. */
  /* ── WHO DECIDES THE WINDOW WAS PLACED ────────────────────────────
       The grammar can only say that the words "June 2026" carry no date it
       recognises; it does not know the vocabulary of 53 entity families.
       The CAPABILITY knows — "archived at", "activated at", "required by"
       are its own concepts — and a claim that carries `from`/`to` has
       placed the window against one of them.

       So the grammar's doubt is a question, not a verdict: this refuses
       only when nothing actually placed it. Reading `intent.unresolved` as
       the verdict refused 35 questions that had been answered correctly. */
  const placed = claims.some((claim) => claim.args?.from || claim.args?.to);
  const windowUnplaced = Boolean(intent?.dateRange) && Boolean(candidates) && !placed;
  if (windowUnplaced) {
    const why = intent.unresolved?.length
      ? intent.unresolved.map((u) => u.why).join("; ")
      : "no business date was named for this range";
    return {
      state: "needs_clarification",
      groups: [],
      note: `Say which date ${intent.dateRange?.source
        ? `"${text(intent.dateRange.source, 60)}"` : "that range"} applies to — ${why}.`,
    };
  }

  if (!claims.length) {
    /* ── BEFORE GIVING UP: IS IT JUST A NAME? ─────────────────────────── */
    /* ── A NAME IS A NAME WHATEVER THE GRAMMAR CALLED IT ──────────────
         "DIBANKSH ENTERPRISES" is a supplier. The grammar reads a trailing
         "s" as a plural and calls it a LIST question, so nothing claimed
         it and it came back "that wording has no exact meaning in Store" —
         about a supplier with three purchase orders. Any question with
         words left in it, that nothing else could answer, is worth asking
         the identity resolvers about. */
    if ((intent.terms || []).length) {
      /* ── EVEN WHEN NOTHING ROUTED ──────────────────────────────────
           "DIBANKSH ENTERPRISES" routes to no capability at all: the
           grammar reads the trailing "s" as a plural, and no declared
           vocabulary matches either word. Gating this on having routed
           somewhere meant a supplier with three purchase orders answered
           "that wording has no exact meaning in Store". */
      let found = await discover(actor, message, tools, { signal });
      /* ── AND ONLY THEN, WHO ACTUALLY HOLDS IT ──────────────────────
           Which capabilities a bare name routes to is decided by declared
           vocabulary, and a material's name matches none of it — so the
           six that get asked are, in effect, arbitrary. When they find
           nothing, the catalogue is asked which family holds a record by
           that name. It is the expensive path and it is last. */
      if (!found.length && nothingRecognised) {
        const { candidates: widened, records } = await lookUpFamily(actor, message, intent);
        /* ── THE RECORD THE NAME IS, BEFORE THE RECORDS THAT MENTION IT ──
             "DIBANKSH ENTERPRISES" is a supplier, and its name is also on
             each of its purchase orders. The supplier is what was typed;
             the orders are neighbours. Both are shown, the supplier first. */
        const own = recordRows(storeToolsFor(actor), records);
        const more = widened.length ? await discover(actor, message, widened, { signal }) : [];
        const shown = new Set(own.map((row) => row.metadata.recordId));
        found = [...own, ...more.filter((row) => !shown.has(row.metadata?.recordId))].slice(0, MAX_ROWS);
      }
      if (found.length) {
        return { state: "answered", groups: [{ label: "Records", results: await withCards(actor, found) }] };
      }
    }
    /* ── THE ONE PLACE A ROUTER MAY SPEAK ──────────────────────────────
         The grammar placed nothing that answered, and no record carries the
         words. Only here — never for a question the grammar understood — an
         optional router may translate the sentence into the catalogue's own
         words, which are then answered by this same path. */
    const routed = await routeUnplaced({ actor, message, intent, router, signal });
    if (routed) return routed;
    /* Routed to nobody at all is different from routed and not recognised,
       and the person can act on the difference. */
    return {
      state: candidates ? "no_match" : "unsupported",
      groups: [],
      note: candidates
        ? "No authorised Store record matches that."
        : "That wording has no exact meaning in Store yet.",
    };
  }

  /* ── SEVERAL CAPABILITIES CLAIMING IS NOT AMBIGUITY ───────────────────
     This used to return an `ambiguous` state with NO results — the person
     typed a question Store could answer and saw an empty panel with a
     sentence telling them to be more exact.

     But two capabilities claiming "stock of macbook" are not two readings
     of one question. They are the stock figure AND the shelf it sits on:
     different facts about the SAME subject, each already scoped and
     permission-checked by the capability that owns it. Showing both is the
     answer. Genuine ambiguity — several RECORDS matching the words — is a
     different thing, and arrives as `choices` from the tool itself, where
     it takes precedence over any fact, since a fact about the wrong record
     is worse than a question.

     Bounded at MAX_ANSWERS and run side by side, so the reply costs one
     read's latency rather than three. */
  /* ── A CONSTRAINED QUESTION GETS ONE ANSWER ──────────────────────────
       Several capabilities answering at once is right for "stock of
       macbook": they are different facts about one subject, and both are
       the answer. It is wrong the moment the question carries a filter.
       "Recorded goods receipts" was answered by the goods-receipt
       capability, correctly filtered, AND by the receiving register, whose
       own vocabulary calls both of them recorded — so the reply contained
       the record the filter excludes, under a sentence that says it was
       filtered. A broader second reading is indistinguishable from a
       wrong one.

       So when the question names a status, a window or a constraint, the
       best-matching capability answers alone. Routing already ranked them;
       this takes the leader at its word. */
  const constrained = Boolean(
    intent.status?.length || intent.dateRange || intent.constraint
    /* A reference names ONE record. A second capability listing its
       neighbours is a broader answer to a question that had exactly one. */
    || intent.reference
    /* And a filter the GRAMMAR did not see but a capability placed from its
       own vocabulary — "accepted development request receipts" names a
       recorded value of a closed set that no general word list contains. */
    || claims.some((claim) => claim.args?.constrained || claim.args?.filterValue
      || claim.args?.from || claim.args?.to),
  );
  /* ── A QUESTION THAT NAMES A FAMILY IS ABOUT THAT FAMILY ─────────────
       "How many material requests are there" was answered three times: the
       material requests, and then the inventory items, and then the request
       desk — because a count is not a filter and all three claimed. Two of
       those are answers to a question nobody asked, sitting under the one
       that was.

       So when the words name a family at all, only the capabilities that
       recognise it that specifically answer. "Stock of macbook" names none,
       and keeps the several readings that are all about the one subject. */
  const named = Math.max(0, ...claims.map((claim) => recognisedLength(claim.tool, message)));
  let onTopic = named > 0
    ? claims.filter((claim) => recognisedLength(claim.tool, message) === named)
    : claims;
  /* ── UNLESS THAT FAMILY'S NAME IS PART OF A LONGER CONCEPT ──────────────
       "next po number" is ONE concept — the Store numbering capability's
       "next po number". The purchase-order capabilities declare "po" as a
       name of their family, so they scored as the specific ones and the
       numbering capability, which declares no family names, was dropped:
       the person asking for the next number was shown ten existing ones.

       The family word "po" sat INSIDE the concept phrase another capability
       claimed with. When every family name that put the leaders on topic is
       part of a longer concept phrase a claiming capability recognised, that
       phrase is what the question names, and the claims that recognised it
       answer. The same longest-name rule, one level down. */
  const phrase = longestConceptPhrase(claims, message);
  if (named > 0 && phrase.length > named) {
    const labels = onTopic.map((claim) => matchedLabel(claim.tool, message)).filter(Boolean);
    if (labels.length && labels.every((label) => includesTerm(phrase, label))) {
      onTopic = claims.filter((claim) => conceptPhrase(claim, message).length === phrase.length);
    }
  }
  const leading = onTopic.slice(0, MAX_ANSWERS);
  const settled = await Promise.all(
    leading.map((claim) => runClaim(actor, message, claim).catch(() => null)),
  );

  const choices = settled.find((out) => out && out.kind === "choices");
  if (choices) {
    return { state: "choices", groups: [{ label: "Which one?", results: choices.results }] };
  }

  /* With a constraint, ONE capability answers: the best-ranked one that
     found anything. Not simply the first — a capability can rank highest
     and hold no matching record, and silence from it is not the answer when
     another capability of the same family has one. */
  /* ── A LIST OF EVERYTHING IS NOT AN ANSWER TO A NARROWER QUESTION ──
       "Stock of a material nobody ever registered" named a material that
       does not exist. The capability recognised the WORD "material",
       applied nothing, and returned the whole catalogue — every item in
       Store, under a sentence the person reads as their answer. That is
       the broad fallback this path is supposed to make impossible.

       The reader now says how much it narrowed by, so a question that
       carried a constraint and narrowed by nothing is refused rather than
       answered with the collection. A question that carried NO constraint
       ("material requests") is a list and stays one. */
  /* ── AND A REFERENCE THAT NAMES NO RECORD IS THE SAME QUESTION ────────
       "PO/2026-27/9999" names a purchase order that does not exist. "PO" is
       a purchase order's own alias, so the collection capability claimed it,
       found no record carrying that number, applied nothing — and answered
       "Matching purchase orders:" with ten orders that do not match. A
       reference is the narrowest question there is; the collection is never
       its answer. Found on the live database, not by the matrix: every
       reference the matrix typed was one it had seeded. */
  /* ── AND SO IS A NUMBER NOTHING ELSE ACCOUNTS FOR ────────────────────
       "development BOM revision 909" names one revision. The grammar calls
       it discovery and keeps "909" as a plain word, no revision carries it,
       and the collection listed every revision there is. A figure in the
       question that is not the row limit and not part of a date window is
       somebody addressing a record, and narrowing by nothing does not
       answer them. */
  const unplacedNumber = (intent.terms || []).find((term) => (
    /\d/.test(term)
      && term !== String(intent.limit ?? "")
      && !String(intent.dateRange?.source || "").includes(term)
  )) || null;
  const constrainedQuestion = Boolean(intent.constraint || intent.reference || unplacedNumber);
  const narrowedNothing = (out) => {
    const data = out?.data;
    if (!data || data.ok !== true) return false;
    if (!Number.isFinite(data.count) || !Number.isFinite(data.storedCount)) return false;
    /* `truncated`: a collection bigger than the scan cap holds more than it
       read, so "read everything it scanned" is the same verdict. */
    return data.appliedConstraints === 0 && data.storedCount > 0
      && (data.count === data.storedCount || (data.truncated && data.count > 0));
  };
  const answering = settled.filter((out) => (
    out && out.kind === "answer" && out.results.length
      && !(constrainedQuestion && narrowedNothing(out))
  ));
  /* ── AND WHEN A REFERENCE WAS TYPED, THE ONE THAT NAMES IT ──────────
       "No matching purchase orders were found" is a result too, so "the
       first that found anything" can be the capability that found nothing
       and said so. A person who typed a document number is answered by
       whichever capability's answer mentions that document. */
  const names = intent.reference
    ? answering.filter((out) => out.results.some((row) => (
      String(row.title || "").includes(intent.reference)
        || String(row.value || "").includes(intent.reference)
    )))
    : [];
  const preferred = names.length ? names : answering;
  const chosen = constrained ? preferred.slice(0, 1) : preferred;

  const results = [];
  const seen = new Set();
  for (const out of chosen) {
    if (!out || out.kind !== "answer") continue;
    for (const result of out.results) {
      /* Two capabilities can phrase the same reading identically. The
         person should see it once. */
      const key = `${result.kind}:${result.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(result);
    }
  }
  if (!results.length) {
    const dropped = constrainedQuestion && settled.some((out) => out && narrowedNothing(out));
    const refused = settled.find((out) => out?.kind === "refused" && out.reason);
    return {
      state: "no_match",
      groups: [],
      note: dropped
        ? `Nothing in Store matches "${text(intent.constraint || intent.reference || unplacedNumber, 80)}". `
          + "The whole collection is not the answer to a narrower question."
        : refused ? refused.reason : "No authorised Store record matches that.",
    };
  }
  return {
    state: "answered",
    groups: [{ label: "Answers", results: await withCards(actor, results.slice(0, MAX_ROWS)) }],
  };
}

/**
 * Answer for the record the person picked.
 *
 * ── EVERY GATE IS CHECKED AGAIN ───────────────────────────────────────────
 * The first request's authority is not carried forward. A selection arrives
 * as a fresh HTTP request and is treated as one: the actor is re-resolved,
 * the Store grant re-read, the capability re-authorised, the concept checked
 * against that capability, and the company compared — before the record is
 * read by its canonical id. Nothing is re-searched, and the display label
 * plays no part.
 */
async function resolveChoice({ user, resolution } = {}) {
  const recordId = text(resolution?.recordId, 100);
  const toolName = text(resolution?.tool, 80);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(recordId) || !toolName) {
    return { state: "unsupported", groups: [] };
  }

  /* 1-2  authenticate the actor and re-resolve Store access. */
  const actor = await resolveStoreActor(user);
  if (!hasStoreApplicationAccess(actor)) return { state: "unauthorised", groups: [] };
  if (!tenantOf(actor)) return { state: "unauthorised", groups: [] };

  /* 3  the capability must still be one this person may use. */
  const tool = storeToolsFor(actor).find((t) => t.name === toolName);
  if (!tool) return { state: "unauthorised", groups: [] };

  /* 4  and it must still belong to Store & Purchase. */
  if (!APPLICATIONS.includes(tool.application)) return { state: "unsupported", groups: [] };

  /* 5  the concept must belong to THIS capability. A concept from another
         tool would read a field the chosen one never offered. */
  const concept = text(resolution?.concept, 160) || null;
  const allowed = tool.parameters?.properties?.metric?.enum;
  if (concept && Array.isArray(allowed) && !allowed.includes(concept)) {
    return { state: "unsupported", groups: [] };
  }

  /* 6  read by canonical identity. The tool scopes the read to the actor's
         own company, as it does for every other caller. */
  try {
    const args = { ...(concept ? { metric: concept } : {}), recordId };
    /* Handed BOTH ways a Store resolver accepts an identity: as an argument,
       and as an already-recognised subject. Each reads it under its own
       tenant scope; neither is given the label. */
    const data = await tool.provideContext({
      user: actor,
      args,
      message: recordId,
      history: [],
      recordId,
      recognizedSubject: {
        found: true,
        recordId,
        entity: text(resolution?.entityType, 80) || tool.semantic?.subjects?.[0] || null,
      },
    });
    /* ── A SENTENCE IS NOT THE SAME AS A RECORD ───────────────────────
       A capability asked for an id it cannot see — one belonging to another
       company, or a record deleted since the choice was offered — still
       renders a sentence, and it is the sentence it gives anybody whose
       words matched nothing. Returning that as `answered` would report a
       failed read as a successful one, so the resolution's own verdict is
       read first. */
    if (notFound(data)) return { state: "no_match", groups: [] };
    const answer = tool.renderAnswer
      ? tool.renderAnswer({ data, args, message: recordId, user: actor })
      : null;
    if (!answer) return { state: "no_match", groups: [] };

    const links = sanitizeAssistantLinks(
      tool.buildLinks ? tool.buildLinks({ data, args, message: recordId, user: actor }) : [],
    );
    return {
      state: "answered",
      groups: [{
        label: "Answer",
        results: await withCards(actor, [{
          id: `resolved:${tool.name}:${recordId}`,
          kind: links[0] ? RESULT_KIND.RECORD : RESULT_KIND.FACT,
          title: text(answer, 300),
          value: text(answer, 300),
          href: links[0]?.href || null,
          entityType: text(resolution?.entityType, 80) || null,
          metadata: { tool: tool.name, concept, recordId, single: true },
        }]),
      }],
    };
  } catch {
    return { state: "no_match", groups: [] };
  }
}

module.exports = {
  APPLICATION, RESULT_KIND, MAX_QUERY, MAX_ROWS, MAX_ANSWERS,
  APPLICATIONS, search, resolveChoice, resolveStoreActor, storeToolsFor,
  claimsFor, hasStoreApplicationAccess, tenantOf,
};
