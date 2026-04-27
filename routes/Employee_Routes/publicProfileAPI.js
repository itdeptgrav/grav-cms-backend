const express = require("express");
const router = express.Router();
const Employee = require("../../models/Employee");

// ─── HELPER: Calculate Tenure (proper format) ────────────────────────────────
function calculateEmployeeTenure(dateOfJoining) {
  const today = new Date();
  const joining = new Date(dateOfJoining);

  let years = today.getFullYear() - joining.getFullYear();
  let months = today.getMonth() - joining.getMonth();
  const days = today.getDate() - joining.getDate();

  if (days < 0) months--;
  if (months < 0) { years--; months += 12; }

  if (years === 0 && months === 0) return "Less than a month";
  if (years === 0) return `${months} ${months === 1 ? "month" : "months"}`;
  if (months === 0) return `${years} ${years === 1 ? "year" : "years"}`;
  return `${years} ${years === 1 ? "year" : "years"}, ${months} ${months === 1 ? "month" : "months"}`;
}

// ─── GET /api/employee/public/:identityId ────────────────────────────────────
router.get("/public/:identityId", async (req, res) => {
  try {
    const { identityId } = req.params;

    const employee = await Employee.findOne({
      identityId: identityId.toUpperCase(),
      isActive: true
    })
      .select('firstName middleName lastName profilePhoto department designation jobTitle dateOfJoining workLocation identityId biometricId phone alternatePhone extension address bloodGroup dateOfBirth employmentType')
      .lean();

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found or inactive"
      });
    }

    const tenure = employee.dateOfJoining
      ? calculateEmployeeTenure(employee.dateOfJoining)
      : null;

    // Format current address (strips private ownershipType field)
    let address = null;
    if (employee.address?.current) {
      const a = employee.address.current;
      if (a.street || a.city || a.state || a.pincode) {
        address = {
          street: a.street || null,
          city: a.city || null,
          state: a.state || null,
          pincode: a.pincode || null,
          country: a.country || null,
        };
      }
    }

    const publicProfile = {
      firstName: employee.firstName,
      middleName: employee.middleName || null,
      lastName: employee.lastName,
      profilePhoto: employee.profilePhoto || null,
      department: employee.department || null,
      designation: employee.designation || null,
      jobTitle: employee.jobTitle || null,
      identityId: employee.identityId || null,
      biometricId: employee.biometricId || null,
      workLocation: employee.workLocation || null,
      dateOfJoining: employee.dateOfJoining || null,
      tenure: tenure,
      phone: employee.phone || null,
      alternatePhone: employee.alternatePhone || null,
      extension: employee.extension || null,
      address: address,
      bloodGroup: employee.bloodGroup || null,
      dateOfBirth: employee.dateOfBirth || null,
      employmentType: employee.employmentType || null,
    };

    res.status(200).json({
      success: true,
      data: publicProfile
    });

  } catch (error) {
    console.error('[PUBLIC-PROFILE-API] Error:', error);
    res.status(500).json({
      success: false,
      message: "Error fetching employee profile"
    });
  }
});

module.exports = router;