const jwt = require("jsonwebtoken");

const EmployeeAuthMiddleware = (req, res, next) => {
  try {
    const token = req.cookies?.employee_token;

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

module.exports = EmployeeAuthMiddleware;
