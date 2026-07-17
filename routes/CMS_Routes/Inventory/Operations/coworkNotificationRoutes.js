// routes/CMS_Routes/Inventory/Operations/coworkNotificationRoutes.js
// Mount: app.use("/api/cowork/notifications", require("./routes/CMS_Routes/Inventory/Operations/coworkNotificationRoutes"))
//
// Push subscribe/unsubscribe for the COWORK (employee) side — uses Firebase
// auth (verifyCoworkToken), not EmployeeAuthMiddleware. Resolves the
// biometricId in the token to the Employee Mongo _id, so userRef matches
// what mrfRoutes.js uses in sendToUser(mrf.requestedFor, ...).

const express = require("express")
const router  = express.Router()
const Employee = require("../../../../models/Employee")
const NotificationService = require("../../../../services/NotificationService")
const { verifyCoworkToken, verifyEmployeeToken } = require("../../../../Middlewear/coworkAuth")

router.use(verifyCoworkToken)
router.use(verifyEmployeeToken)

async function resolveEmployeeId(biometricId) {
  const emp = await Employee.findOne({
    $or: [{ biometricId }, { identityId: biometricId }]
  }).select("_id firstName middleName lastName").lean()
  return emp
}

router.get("/vapid-public-key", (req, res) => {
  if (!NotificationService.isConfigured())
    return res.status(503).json({ success: false, message: "Push not configured on server" })
  res.json({ success: true, publicKey: NotificationService.getPublicKey() })
})

router.post("/subscribe", async (req, res) => {
  try {
    const { subscription } = req.body
    if (!subscription?.endpoint)
      return res.status(400).json({ success: false, message: "subscription required" })

    const emp = await resolveEmployeeId(req.coworkUser.employeeId)
    if (!emp) return res.status(404).json({ success: false, message: "Employee record not found" })

    await NotificationService.saveSubscription({
      endpoint:  subscription.endpoint,
      keys:      subscription.keys,
      userRef:   emp._id,                 // ← matches mrf.requestedFor
      userName:  req.coworkUser.name || "",
      role:      "employee",
      userAgent: req.headers["user-agent"] || "",
    })
    res.json({ success: true, message: "Subscribed to notifications" })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
})

router.post("/unsubscribe", async (req, res) => {
  try {
    await NotificationService.removeSubscription(req.body.endpoint)
    res.json({ success: true, message: "Unsubscribed" })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
})

module.exports = router