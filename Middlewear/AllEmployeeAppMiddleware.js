const jwt = require("jsonwebtoken");

// ─── Intern lock-out ─────────────────────────────────────────────────────────
//
// Interns have no app account. Refusing them at /login is most of it, but a
// token already issued keeps working for up to 30 days, so somebody moved from
// staff to intern would keep their access for a month — exactly the window
// where you would want it gone.
//
// So the check is here as well, on every request. It costs one indexed lookup
// per employee per five minutes; the shape is borrowed from
// Middlewear/coworkAuth.js, which caches its employee lookups the same way.
const ACCESS_TTL_MS = 5 * 60 * 1000;
const accessCache = new Map(); // employeeId -> { allowed, at }

/** Forget a cached decision — call after changing someone's employment type. */
function invalidateAppAccess(employeeId) {
  if (employeeId) accessCache.delete(String(employeeId));
}

async function isAppUser(employeeId) {
  const key = String(employeeId);
  const hit = accessCache.get(key);
  if (hit && Date.now() - hit.at < ACCESS_TTL_MS) return hit.allowed;

  const Employee = require("../models/Employee");
  try {
    const emp = await Employee.findById(key).select("employmentType").lean();
    // A token for a deleted employee is not this middleware's problem to
    // diagnose — the routes behind it already handle a missing record — so an
    // unknown id is allowed through and fails there with a clearer message.
    const allowed = !emp || emp.employmentType !== "intern";
    accessCache.set(key, { allowed, at: Date.now() });
    return allowed;
  } catch (err) {
    // Mongo is unreachable. Signing the entire workforce out of the app over
    // an infrastructure blip is the worse failure — and the lock is enforced
    // at /login too, so nobody NEW gets in while this is down. Not cached, so
    // the next request tries again.
    console.warn("[APP-ACCESS] employment-type check failed:", err.message);
    return true;
  }
}

const AllEmployeeAppMiddleware = async (req, res, next) => {
  try {
    // 1. Try cookie first (Android / Windows / desktop — works as before)
    let token = req.cookies?.employee_token;

    // 2. If no cookie, try Bearer token from Authorization header (iOS Safari fix)
    if (!token && req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }

    // 3. Last fallback: manually parse cookie header (some iOS edge cases)
    if (!token && req.headers.cookie) {
      const match = req.headers.cookie.match(/employee_token=([^;]+)/);
      if (match) token = match[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Not authorized, token missing",
      });
    }

    var decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Not authorized, token invalid",
    });
  }

  // Outside the try above on purpose: a failure in here is not a bad token,
  // and reporting it as one sends the app to the login screen to retry
  // something that was never wrong.
  if (decoded.id && !(await isAppUser(decoded.id))) {
    return res.status(403).json({
      success: false,
      code: "INTERN_NO_APP_ACCESS",
      message: "The GRAV app is for employees. Interns do not have access.",
    });
  }

  req.user = {
    id: decoded.id,
    email: decoded.email,
    type: decoded.type,
  };

  next();
};

module.exports = AllEmployeeAppMiddleware;
module.exports.invalidateAppAccess = invalidateAppAccess;
