const { auth, db, admin } = require("../config/firebaseAdmin");

async function verifyCoworkToken(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing token" });

    const decoded = await auth.verifyIdToken(header.split("Bearer ")[1]);

    // Lookup by authUid
    let snap = await db.collection("cowork_employees").where("authUid", "==", decoded.uid).limit(1).get();

    // Fallback: by email
    if (snap.empty && decoded.email) {
      snap = await db.collection("cowork_employees").where("email", "==", decoded.email).limit(1).get();
    }

    // Auto-create CEO doc if claims say ceo
    if (snap.empty) {
      const user = await auth.getUser(decoded.uid);
      const claims = user.customClaims || {};
      if (claims.role === "ceo") {
        const ceoData = {
          employeeId: "E000", authUid: decoded.uid,
          name: user.displayName || "CEO", email: decoded.email || "",
          mobile: "", city: "", department: "Management",
          role: "ceo", profilePicUrl: null, fcmTokens: [],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await db.collection("cowork_employees").doc("E000").set(ceoData, { merge: true });
        req.coworkUser = { authUid: decoded.uid, employeeId: "E000", role: "ceo", name: ceoData.name, employeeData: ceoData };
        return next();
      }
      return res.status(403).json({ error: "Employee not found in Firestore. Ask your CEO." });
    }

    const data = snap.docs[0].data();
    if (!data.authUid) await snap.docs[0].ref.update({ authUid: decoded.uid });

    req.coworkUser = { authUid: decoded.uid, employeeId: data.employeeId, role: data.role, name: data.name, employeeData: data };
    next();
  } catch (err) {
    res.status(401).json({ error: "Auth error: " + err.message });
  }
}

const verifyCeoToken = (req, res, next) => req.coworkUser?.role === "ceo" ? next() : res.status(403).json({ error: "CEO only" });
const verifyEmployeeToken = (req, res, next) => req.coworkUser ? next() : res.status(401).json({ error: "Unauthorized" });

module.exports = { verifyCoworkToken, verifyCeoToken, verifyEmployeeToken };
