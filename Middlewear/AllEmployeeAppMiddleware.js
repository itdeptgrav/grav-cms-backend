const jwt = require("jsonwebtoken");

const AllEmployeeAppMiddleware = (req, res, next) => {
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

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      id: decoded.id,
      email: decoded.email,
      type: decoded.type,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Not authorized, token invalid",
    });
  }
};

module.exports = AllEmployeeAppMiddleware;
