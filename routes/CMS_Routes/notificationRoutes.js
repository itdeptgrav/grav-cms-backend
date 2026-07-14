// routes/CMS_Routes/notificationRoutes.js
// Mount: app.use("/api/cms/notifications", require("./routes/CMS_Routes/notificationRoutes"))

const express = require("express");
const router  = express.Router();
const EmployeeAuth = require("../../Middlewear/EmployeeAuthMiddlewear");
const NotificationService = require("../../services/NotificationService");

// Public key can be fetched before login-bound auth if needed; keep it behind
// auth here since only logged-in users subscribe.
router.use(EmployeeAuth);

// GET /vapid-public-key — frontend needs this to subscribe
router.get("/vapid-public-key", (req, res) => {
  if (!NotificationService.isConfigured())
    return res.status(503).json({ success: false, message: "Push not configured on server" });
  res.json({ success: true, publicKey: NotificationService.getPublicKey() });
});


// TEMP diagnostic — remove after debugging
router.get("/test", async (req, res) => {
  const PushSubscription = require("../../models/CMS_Models/Notifications/PushSubscription");
  const subs = await PushSubscription.find({}).select("role userName endpoint").lean();
  const result = await NotificationService.sendToUser(req.user._id || req.user.id, {
    title: "Test notification",
    body: "If you see this, the pipe works end-to-end.",
    url: "/project-manager/dashboard/requests",
  });
  res.json({
    configured: NotificationService.isConfigured(),
    yourRole: req.user.role,
    savedSubscriptions: subs.map(s => ({ role: s.role, user: s.userName })),
    sendResult: result,
  });
});

// POST /subscribe — body: { subscription: PushSubscriptionJSON }
router.post("/subscribe", async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint)
      return res.status(400).json({ success: false, message: "subscription required" });

    await NotificationService.saveSubscription({
      endpoint:  subscription.endpoint,
      keys:      subscription.keys,
      userRef:   req.user._id || req.user.id || null,
      userName:  req.user.name || "",
      role:      req.user.role || "",
      userAgent: req.headers["user-agent"] || "",
    });
    res.json({ success: true, message: "Subscribed to notifications" });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /unsubscribe — body: { endpoint }
router.post("/unsubscribe", async (req, res) => {
  try {
    await NotificationService.removeSubscription(req.body.endpoint);
    res.json({ success: true, message: "Unsubscribed" });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;