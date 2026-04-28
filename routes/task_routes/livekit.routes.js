/**
 * BACKEND: routes/task_routes/livekit.routes.js
 *
 * HOW TO REGISTER — add ONE line in your server.js / app.js:
 *   app.use("/cowork", require("./routes/task_routes/livekit.routes"));
 *
 * ENDPOINTS:
 *   POST /cowork/livekit/start      → CEO/TL starts a meeting, get join code
 *   POST /cowork/livekit/join       → Anyone joins with a 6-digit code
 *   POST /cowork/livekit/token      → Get LiveKit token (after code verified)
 *   GET  /cowork/livekit/info/:meetId → Get live room info
 *   POST /cowork/livekit/end        → CEO/TL ends meeting
 */

const express = require("express");
const router = express.Router();

// livekit-server-sdk v2+ uses named exports
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");

const {
    verifyCoworkToken,
    verifyEmployeeToken,
    verifyCeoToken,
} = require("../../Middlewear/coworkAuth");

const { admin, db } = require("../../config/firebaseAdmin");

// ── Read LiveKit env vars ─────────────────────────────────────────────────────
const LK_URL = process.env.LIVEKIT_URL;
const LK_KEY = process.env.LIVEKIT_API_KEY;
const LK_SECRET = process.env.LIVEKIT_API_SECRET;

// RoomServiceClient needs https:// not wss://
function getRoomSvc() {
    const url = (LK_URL || "")
        .replace("wss://", "https://")
        .replace("ws://", "http://");
    return new RoomServiceClient(url, LK_KEY, LK_SECRET);
}

// ── Generate a random 6-digit join code ───────────────────────────────────────
function makeJoinCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /cowork/livekit/start
// CEO or TL starts a meeting → creates LiveKit room + join code
// Body: { meetId }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    "/livekit/start",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            const { role, employeeId, name } = req.coworkUser;

            if (role !== "ceo" && role !== "tl") {
                return res.status(403).json({ error: "Only CEO or TL can start a meeting." });
            }

            const { meetId } = req.body;
            if (!meetId) return res.status(400).json({ error: "meetId required" });

            // Verify meet exists
            const meetRef = db.collection("cowork_scheduled_meets").doc(meetId);
            const meetDoc = await meetRef.get();
            if (!meetDoc.exists) return res.status(404).json({ error: "Meeting not found" });

            const meet = meetDoc.data();

            // If already live, return existing room info
            if (meet.livekitRoomName && meet.status === "live") {
                // Generate a fresh token for the host
                const token = await buildToken(meet.livekitRoomName, employeeId, name, true);
                return res.json({
                    success: true,
                    roomName: meet.livekitRoomName,
                    joinCode: meet.joinCode,
                    token,
                    url: LK_URL,
                    alreadyLive: true,
                });
            }

            // Create a new LiveKit room
            const roomName = `cowork-${meetId}-${Date.now()}`;
            const joinCode = makeJoinCode();

            try {
                const svc = getRoomSvc();
                await svc.createRoom({
                    name: roomName,
                    emptyTimeout: 300,   // auto-close after 5 min if empty
                    maxParticipants: 100,
                });
            } catch (livekitErr) {
                console.error("LiveKit createRoom error:", livekitErr.message);
                return res.status(500).json({ error: "Could not create LiveKit room: " + livekitErr.message });
            }

            // Save to Firestore
            await meetRef.update({
                livekitRoomName: roomName,
                joinCode,
                status: "live",
                livekitStartedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            // Save join code as a lookup doc for fast /join lookup
            await db.collection("cowork_join_codes").doc(joinCode).set({
                meetId,
                roomName,
                createdBy: employeeId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours — matches token TTL
                active: true,
            });

            // Build token for host
            const token = await buildToken(roomName, employeeId, name, true);

            res.json({
                success: true,
                roomName,
                joinCode,
                token,
                url: LK_URL,
            });
        } catch (e) {
            console.error("livekit/start error:", e);
            res.status(500).json({ error: e.message });
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /cowork/livekit/join
// Anyone joins by pasting a 6-digit code
// Body: { joinCode }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    "/livekit/join",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            const { employeeId, name } = req.coworkUser;
            const { joinCode } = req.body;

            if (!joinCode) return res.status(400).json({ error: "joinCode required" });

            const codeDoc = await db.collection("cowork_join_codes").doc(joinCode.trim()).get();

            if (!codeDoc.exists) {
                return res.status(404).json({ error: "Invalid join code. Please check and try again." });
            }

            const codeData = codeDoc.data();

            if (!codeData.active) {
                return res.status(400).json({ error: "This meeting has ended." });
            }

            // Check expiry
            if (codeData.expiresAt && new Date() > codeData.expiresAt.toDate()) {
                return res.status(400).json({ error: "This join code has expired." });
            }

            // Get the meet
            const meetDoc = await db.collection("cowork_scheduled_meets").doc(codeData.meetId).get();
            const meet = meetDoc.exists ? meetDoc.data() : null;

            if (!meet || meet.status === "ended") {
                return res.status(400).json({ error: "This meeting has ended." });
            }

            // Build token (non-admin for regular joiners)
            const isAdmin = req.coworkUser.role === "ceo" || req.coworkUser.role === "tl";
            const token = await buildToken(codeData.roomName, employeeId, name, isAdmin);

            // Log participant
            await db.collection("cowork_meeting_participants").add({
                meetId: codeData.meetId,
                roomName: codeData.roomName,
                employeeId,
                employeeName: name,
                joinedAt: admin.firestore.FieldValue.serverTimestamp(),
                active: true,
            });

            res.json({
                success: true,
                token,
                url: LK_URL,
                roomName: codeData.roomName,
                meetId: codeData.meetId,
                meetTitle: meet.title || "CoWork Meeting",
            });
        } catch (e) {
            console.error("livekit/join error:", e);
            res.status(500).json({ error: e.message });
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/livekit/info/:meetId
// Get live room status + participant count + join code (for host)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
    "/livekit/info/:meetId",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            const meetDoc = await db
                .collection("cowork_scheduled_meets")
                .doc(req.params.meetId)
                .get();

            if (!meetDoc.exists) return res.status(404).json({ error: "Meeting not found" });

            const meet = meetDoc.data();

            if (!meet.livekitRoomName || meet.status !== "live") {
                return res.json({ live: false, participantCount: 0, status: meet.status || "scheduled" });
            }

            // Try to get participant count from LiveKit
            let participantCount = 0;
            try {
                const svc = getRoomSvc();
                const rooms = await svc.listRooms([meet.livekitRoomName]);
                participantCount = rooms[0]?.numParticipants || 0;
            } catch { /* LiveKit might not have this room anymore */ }

            res.json({
                live: true,
                roomName: meet.livekitRoomName,
                joinCode: meet.joinCode || null,
                participantCount,
                status: meet.status,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /cowork/livekit/end
// CEO/TL ends the meeting
// Body: { meetId }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    "/livekit/end",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            const { role } = req.coworkUser;
            if (role !== "ceo" && role !== "tl") {
                return res.status(403).json({ error: "Only CEO or TL can end a meeting." });
            }

            const { meetId } = req.body;
            const meetDoc = await db.collection("cowork_scheduled_meets").doc(meetId).get();
            if (!meetDoc.exists) return res.status(404).json({ error: "Meeting not found" });

            const meet = meetDoc.data();

            // Delete the LiveKit room
            if (meet.livekitRoomName) {
                try {
                    const svc = getRoomSvc();
                    await svc.deleteRoom(meet.livekitRoomName);
                } catch { /* room may already be empty */ }
            }

            // Deactivate join code
            if (meet.joinCode) {
                await db.collection("cowork_join_codes").doc(meet.joinCode).update({ active: false });
            }

            // Update meet status
            await db.collection("cowork_scheduled_meets").doc(meetId).update({
                status: "ended",
                livekitEndedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            res.json({ success: true });
        } catch (e) {
            console.error("livekit/end error:", e);
            res.status(500).json({ error: e.message });
        }
    }
);

// ── Helper: build a LiveKit JWT token ─────────────────────────────────────────
// ttl: "24h" — meeting can run a full day without token expiring.
// The meeting still ends when the host clicks "End for All" or when the
// Firestore `status` is set to "ended" — TTL is just the cap on a single
// participant's token session, not the meeting length.
async function buildToken(roomName, identity, participantName, isAdmin = false) {
    const at = new AccessToken(LK_KEY, LK_SECRET, {
        identity,
        name: participantName,
        ttl: "24h",
    });

    at.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        roomAdmin: isAdmin,
    });

    return at.toJwt();
}

module.exports = router;