/**
 * GRAV-CMS-BACKEND/routes/task_routes/coworkMindmaps.js
 *
 * Cowork mindmaps — list, open, create, rename, delete, save.
 *
 * ## Why this is a route and not a browser write
 *
 * Cowork documents write browser-to-Firestore. Mindmaps do not, and the
 * difference is the tree: a document body is opaque text that cannot be
 * malformed, while a mindmap body is a STRUCTURE the reader has to lay out. A
 * tree with two roots, a parent that does not exist, or a cycle is not a map
 * that looks wrong — it is a map that cannot be drawn at all, and a check that
 * lives in the browser is one an edited request simply skips.
 *
 * So the validation below is the point of the route rather than a formality.
 * Everything it refuses is something that would otherwise be stored and then
 * fail to render for every member of that map, including the ones who did not
 * write it.
 *
 * ## Where it is stored
 *
 * Firestore, beside every other Cowork collection (`cowork_tasks`,
 * `cowork_employees`, …) rather than in Mongo, which holds the ERP:
 *
 *  · `cowork_mindmaps`        — the record: title, members, timestamps, count.
 *  · `cowork_mindmap_bodies`  — the cards, keyed by the record's id.
 *
 * Split because a list of thirty maps must not read thirty node trees to draw a
 * table of names, and Firestore bills per document read rather than per field.
 *
 * ## Membership, and what a stranger is told
 *
 * A map you are not a member of answers 404, never 403. A 403 on an id confirms
 * the id is real, which is a disclosure the person asking has not earned.
 */

const express = require("express");
const { db } = require("../../config/firebaseAdmin");
const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");

const router = express.Router();

const MAPS = "cowork_mindmaps";
const BODIES = "cowork_mindmap_bodies";

/**
 * The organisation every Cowork record is stamped with.
 *
 * Matches `LEGACY_ORGANISATION_ID` in the Cowork client — the two have to agree
 * or a record written here reads back as belonging to nobody. Legacy is
 * single-tenant, so this is a constant; it is written rather than omitted so
 * the field is already there on the day there is a second tenant.
 */
const ORGANISATION_ID = "org-legacy-cowork";

/* ── Limits ─────────────────────────────────────────────────────────────────
 *
 * Each is a real Firestore boundary rather than a taste, and each is enforced
 * here rather than in the browser because the browser is not the only thing
 * that can send a body.
 */

/** Cards in one map. Far above any map a person would draw, well under the
    point at which the body document approaches its size limit. */
const MAX_NODES = 2000;

/**
 * Serialised body bytes.
 *
 * A Firestore document cannot exceed 1,048,487 bytes. Refusing at 900KB leaves
 * room for the field names and the timestamp and — more usefully — refuses
 * while the person can still be told what to shorten, rather than letting
 * Firestore reject the write with a message about bytes.
 */
const MAX_BODY_BYTES = 900_000;

const MAX_TITLE = 200;
const MAX_NODE_TITLE = 500;
const MAX_DESCRIPTION = 20_000;
const MAX_LINKS = 50;
const MAX_IMAGES = 20;

/* ── Reading what was sent ─────────────────────────────────────────────────── */

const str = (v, fallback = "") => (typeof v === "string" ? v : fallback);

const clamp = (v, max) => str(v).slice(0, max);

/**
 * A stored record, in the shape the Cowork client expects.
 *
 * `nodeCount` is denormalised onto the record because the list shows it and the
 * list does not read bodies. It is written by the one place that writes cards,
 * so it cannot drift from them.
 */
function readRecord(id, raw) {
  const members = Array.isArray(raw.members)
    ? raw.members
        .filter((m) => m && typeof m.employeeId === "string")
        .map((m) => ({
          employeeId: m.employeeId,
          role: m.role === "owner" || m.role === "viewer" ? m.role : "editor",
          addedAt: str(m.addedAt, str(raw.createdAt)),
        }))
    : [];
  const createdAt = str(raw.createdAt);
  return {
    organisationId: str(raw.organisationId, ORGANISATION_ID),
    id,
    title: str(raw.title).trim() || "Untitled mindmap",
    createdById: str(raw.createdById),
    lastEditedById:
      typeof raw.lastEditedById === "string" ? raw.lastEditedById : null,
    members,
    memberIds: [...new Set(members.map((m) => m.employeeId))],
    nodeCount: Number.isFinite(raw.nodeCount) ? Number(raw.nodeCount) : 0,
    createdAt,
    /* Falls back to `createdAt` rather than to now. A record written before this
       field existed has not just been touched, and saying it was would sort it
       to the top of a list ordered by recency. */
    updatedAt: str(raw.updatedAt, createdAt),
    deletedAt: typeof raw.deletedAt === "string" ? raw.deletedAt : null,
  };
}

/**
 * Validate a card tree, and say exactly what is wrong with it.
 *
 * Returns `{ nodes }` or `{ error }`. The error is written to be shown to a
 * person: it names the card rather than the index, because "the card 'Q3
 * launch' hangs off a card that is not in this map" is actionable and "node 47
 * is invalid" is not.
 *
 * The checks run in dependency order — shape, then uniqueness, then exactly one
 * root, then parent references, then cycles — because each assumes the last one
 * passed. A cycle check on a tree with duplicate ids would loop forever.
 */
function validateNodes(input) {
  if (!Array.isArray(input)) return { error: "nodes must be an array." };
  if (input.length === 0)
    return { error: "A mindmap needs at least a root card." };
  if (input.length > MAX_NODES)
    return {
      error: `A mindmap can hold ${MAX_NODES} cards. This one has ${input.length}.`,
    };

  const nodes = [];
  const seen = new Set();

  for (const raw of input) {
    if (!raw || typeof raw !== "object")
      return { error: "Every card must be an object." };
    const id = str(raw.id);
    if (!id) return { error: "Every card needs an id." };
    if (seen.has(id))
      return { error: `Two cards share the id "${id}". Ids must be unique.` };
    seen.add(id);

    const parentId = raw.parentId === null ? null : str(raw.parentId);
    if (raw.parentId !== null && !parentId)
      return { error: `The card "${id}" has an unreadable parent.` };

    const links = Array.isArray(raw.links)
      ? raw.links
          .filter((l) => l && typeof l.url === "string")
          .slice(0, MAX_LINKS)
          .map((l) => ({
            id: str(l.id) || str(l.url).slice(0, 40),
            url: clamp(l.url, 2000),
            label: clamp(l.label, 200),
          }))
      : [];

    const images = [];
    for (const img of Array.isArray(raw.images) ? raw.images : []) {
      if (!img || typeof img !== "object") continue;
      /* **Bytes are refused, and the refusal names the fix.** A base64 picture
         on a card was how the browser-only map stored images. One of them fills
         a Firestore document on its own, so a map with three would be
         unsaveable — and a silently dropped picture is worse than a refusal,
         because the person keeps working on a map they believe is saved. */
      if (typeof img.dataUrl === "string" && img.dataUrl.length > 0)
        return {
          error:
            `The picture "${str(img.name, "untitled")}" is stored in this browser rather than uploaded. ` +
            `Remove it and attach it again — pictures are uploaded now, so they follow the map to everyone who can see it.`,
        };
      images.push({
        id: str(img.id),
        name: clamp(img.name, 300),
        fileId: typeof img.fileId === "string" ? img.fileId : null,
        url: typeof img.url === "string" ? img.url : null,
        sizeBytes: Number.isFinite(img.sizeBytes) ? Number(img.sizeBytes) : 0,
      });
      if (images.length >= MAX_IMAGES) break;
    }

    nodes.push({
      id,
      parentId: raw.parentId === null ? null : parentId,
      title: clamp(raw.title, MAX_NODE_TITLE),
      description: clamp(raw.description, MAX_DESCRIPTION),
      links,
      images,
      collapsed: raw.collapsed === true,
    });
  }

  const roots = nodes.filter((n) => n.parentId === null);
  if (roots.length === 0)
    return {
      error: "This map has no root card, so there is nothing to draw it from.",
    };
  if (roots.length > 1)
    return {
      error: `This map has ${roots.length} root cards. A mindmap has exactly one.`,
    };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    if (node.parentId !== null && !byId.has(node.parentId))
      return {
        error: `The card "${node.title || node.id}" hangs off a card that is not in this map.`,
      };
  }

  /* Cycles. Every card must reach the root by walking up; a walk longer than the
     card count has re-entered a loop. Checked per card rather than once from the
     root, because a detached ring never touches the root at all and a downward
     walk would simply never visit it. */
  for (const node of nodes) {
    let steps = 0;
    let cursor = node;
    while (cursor.parentId !== null) {
      cursor = byId.get(cursor.parentId);
      steps += 1;
      if (steps > nodes.length)
        return {
          error: `The card "${node.title || node.id}" is part of a loop — a card cannot be its own ancestor.`,
        };
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify(nodes), "utf8");
  if (bytes > MAX_BODY_BYTES)
    return {
      error:
        `This map is too large to save (${Math.round(bytes / 1024)}KB of ${Math.round(MAX_BODY_BYTES / 1024)}KB). ` +
        `Long descriptions are the usual cause.`,
    };

  return { nodes };
}

/**
 * The record, if this person may see it. Null covers both "no such map" and
 * "not yours" — see the header for why those are one answer.
 */
async function readableRecord(id, employeeId) {
  const snap = await db.collection(MAPS).doc(String(id)).get();
  if (!snap.exists) return null;
  const record = readRecord(snap.id, snap.data() || {});
  if (record.deletedAt) return null;
  if (!record.memberIds.includes(String(employeeId))) return null;
  return record;
}

/** Whether this person may rename, delete or change who is on a map. */
function mayManage(record, employeeId) {
  return record.members.some(
    (m) => m.employeeId === String(employeeId) && m.role === "owner",
  );
}

/** Whether this person may change the cards. Viewers may not. */
function mayEdit(record, employeeId) {
  return record.members.some(
    (m) =>
      m.employeeId === String(employeeId) &&
      (m.role === "owner" || m.role === "editor"),
  );
}

/* ── Routes ─────────────────────────────────────────────────────────────────
 *
 * Mounted under `/cowork`, so these are `/cowork/mindmaps…`. Every one is
 * authenticated; there is no public read.
 */

/**
 * The list.
 *
 * Records only — no bodies. The card count comes off the record, which is why
 * it is stored there.
 */
router.get(
  "/mindmaps",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const snap = await db
        .collection(MAPS)
        .where("memberIds", "array-contains", me)
        .get();
      const mindmaps = snap.docs
        .map((d) => readRecord(d.id, d.data() || {}))
        .filter((m) => !m.deletedAt)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      res.json({ mindmaps });
    } catch (err) {
      res.status(500).json({ error: "Could not list mindmaps: " + err.message });
    }
  },
);

/** One map, with its cards. The only read that touches a body. */
router.get(
  "/mindmaps/:id",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const record = await readableRecord(
        req.params.id,
        req.coworkUser.employeeId,
      );
      if (!record) return res.status(404).json({ error: "Mindmap not found." });
      const body = await db.collection(BODIES).doc(record.id).get();
      const raw = body.exists ? body.data() || {} : {};
      res.json({
        mindmap: record,
        /* An absent body is an empty array rather than an error: the record is
           real and openable, and the client seeds a root into an empty map. */
        nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
      });
    } catch (err) {
      res.status(500).json({ error: "Could not open mindmap: " + err.message });
    }
  },
);

/**
 * Create one.
 *
 * The creator is always a member and always the owner. A map nobody can open is
 * not a map, and a member list that forgot its author is how that happens.
 *
 * It is created WITH a root card. An empty mindmap cannot be drawn and its only
 * possible first action is "add the root", so the server does that rather than
 * shipping a state whose only exit is one button.
 */
router.post(
  "/mindmaps",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const now = new Date().toISOString();
      const title =
        clamp(req.body && req.body.title, MAX_TITLE).trim() || "Untitled mindmap";

      const supplied = Array.isArray(req.body && req.body.memberIds)
        ? req.body.memberIds
        : [];
      const memberIds = [
        ...new Set([
          me,
          ...supplied
            .filter((x) => typeof x === "string" || typeof x === "number")
            .map(String),
        ]),
      ];
      const members = memberIds.map((employeeId) => ({
        employeeId,
        role: employeeId === me ? "owner" : "editor",
        addedAt: now,
      }));

      /* Cards may be supplied — that is how a map kept in a browser is lifted
         onto the server. Validated exactly as a later save is: an import is not
         a trusted path just because it is the first write. */
      const suppliedNodes = req.body && req.body.nodes;
      let nodes = [
        {
          id: "root",
          parentId: null,
          title,
          description: "",
          links: [],
          images: [],
          collapsed: false,
        },
      ];
      if (suppliedNodes !== undefined) {
        const checked = validateNodes(suppliedNodes);
        if (checked.error) return res.status(400).json({ error: checked.error });
        nodes = checked.nodes;
      }

      const ref = db.collection(MAPS).doc();
      const record = {
        organisationId: ORGANISATION_ID,
        title,
        createdById: me,
        lastEditedById: null,
        members,
        memberIds,
        nodeCount: nodes.length,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await ref.set(record);
      await db
        .collection(BODIES)
        .doc(ref.id)
        .set({ mindmapId: ref.id, nodes, updatedAt: now });

      res.status(201).json({ mindmap: readRecord(ref.id, record) });
    } catch (err) {
      res
        .status(500)
        .json({ error: "Could not create mindmap: " + err.message });
    }
  },
);

/** Rename. Owners only — the title is how everybody else finds it. */
router.patch(
  "/mindmaps/:id",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Mindmap not found." });
      if (!mayManage(record, me))
        return res
          .status(403)
          .json({ error: "Only an owner can rename this mindmap." });

      const title = clamp(req.body && req.body.title, MAX_TITLE).trim();
      if (!title)
        return res.status(400).json({ error: "Give the mindmap a name." });

      const now = new Date().toISOString();
      await db
        .collection(MAPS)
        .doc(record.id)
        .update({ title, updatedAt: now, lastEditedById: me });
      res.json({
        mindmap: { ...record, title, updatedAt: now, lastEditedById: me },
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: "Could not rename mindmap: " + err.message });
    }
  },
);

/**
 * Delete. **Soft**, and owners only.
 *
 * The body is left where it is. A map removed from a list is recoverable until
 * something reaps it, and reaping the cards at the same moment would make the
 * record recoverable and the map itself not.
 */
router.delete(
  "/mindmaps/:id",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Mindmap not found." });
      if (!mayManage(record, me))
        return res
          .status(403)
          .json({ error: "Only an owner can delete this mindmap." });

      const now = new Date().toISOString();
      await db
        .collection(MAPS)
        .doc(record.id)
        .update({ deletedAt: now, updatedAt: now });
      res.json({ ok: true });
    } catch (err) {
      res
        .status(500)
        .json({ error: "Could not delete mindmap: " + err.message });
    }
  },
);

/**
 * Save the cards. **The whole tree, every time.**
 *
 * Not a patch, and that is the correct shape rather than a lazy one: a mindmap
 * edit is frequently structural — reparenting a branch changes one field on one
 * card and the meaning of every card under it — so a per-card patch protocol
 * would have to describe moves, and two clients applying different moves would
 * produce a tree neither of them authored. Replacing the tree makes the last
 * writer's map the map, which is a rule a person can predict.
 *
 * The validation is the one `POST` runs. There is no path into the body
 * collection that skips it.
 */
router.put(
  "/mindmaps/:id/nodes",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Mindmap not found." });
      if (!mayEdit(record, me))
        return res
          .status(403)
          .json({ error: "You can view this mindmap but not change it." });

      const checked = validateNodes(req.body && req.body.nodes);
      if (checked.error) return res.status(400).json({ error: checked.error });

      const now = new Date().toISOString();
      await db
        .collection(BODIES)
        .doc(record.id)
        .set({ mindmapId: record.id, nodes: checked.nodes, updatedAt: now });
      /* `nodeCount` lives on the record so the list never reads a body. Written
         here, in the one place that writes cards, so it cannot drift. */
      await db.collection(MAPS).doc(record.id).update({
        updatedAt: now,
        lastEditedById: me,
        nodeCount: checked.nodes.length,
      });

      res.json({
        mindmap: {
          ...record,
          updatedAt: now,
          lastEditedById: me,
          nodeCount: checked.nodes.length,
        },
        nodes: checked.nodes,
      });
    } catch (err) {
      res.status(500).json({ error: "Could not save mindmap: " + err.message });
    }
  },
);

/**
 * Add somebody, change what they may do, or remove them.
 *
 * `role: null` removes. The last owner cannot be removed or demoted — a map
 * with no owner cannot be renamed, deleted or shared by anybody, including the
 * person who made it, so nothing is allowed to write one.
 */
router.put(
  "/mindmaps/:id/members/:employeeId",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Mindmap not found." });
      if (!mayManage(record, me))
        return res
          .status(403)
          .json({ error: "Only an owner can change who is on this mindmap." });

      const target = String(req.params.employeeId);
      const role = (req.body && req.body.role) ?? null;
      if (role !== null && !["owner", "editor", "viewer"].includes(role))
        return res
          .status(400)
          .json({ error: "Role must be owner, editor, viewer, or null." });

      const existing = record.members.find((m) => m.employeeId === target);
      const rest = record.members.filter((m) => m.employeeId !== target);
      const next =
        role === null
          ? rest
          : [
              ...rest,
              {
                employeeId: target,
                role,
                addedAt: existing ? existing.addedAt : new Date().toISOString(),
              },
            ];

      if (!next.some((m) => m.role === "owner"))
        return res.status(400).json({
          error:
            "A mindmap needs an owner. Make somebody else an owner before removing this one.",
        });

      const now = new Date().toISOString();
      const memberIds = [...new Set(next.map((m) => m.employeeId))];
      await db
        .collection(MAPS)
        .doc(record.id)
        .update({ members: next, memberIds, updatedAt: now });
      res.json({
        mindmap: { ...record, members: next, memberIds, updatedAt: now },
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: "Could not change mindmap members: " + err.message });
    }
  },
);

/**
 * `validateNodes` attached to the router function rather than exported via a
 * second name — `server.js` mounts this file's return value directly as
 * `app.use("/cowork", require(...))`, so `module.exports` has to stay the
 * router. A property on the router (a function, so it can carry one) is a
 * factored-out validator without a second require path or a mount-site
 * change: `coworkExternalShare.routes.js` reads
 * `require("./coworkMindmaps.js").validateNodes` and gets the exact function
 * an employee's own save runs through, not a re-implementation of it that
 * could drift.
 */
router.validateNodes = validateNodes;

module.exports = router;
