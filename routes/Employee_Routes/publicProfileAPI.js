const express = require("express");
const router = express.Router();
const Employee = require("../../models/Employee");

// ─── HELPER: Calculate Tenure ─────────────────────────────────────────────────
function calculateEmployeeTenure(dateOfJoining) {
  const today = new Date();
  const joining = new Date(dateOfJoining);
  let years = today.getFullYear() - joining.getFullYear();
  let months = today.getMonth() - joining.getMonth();

  if (months < 0) {
    years--;
    months += 12;
  }

  if (years === 0 && months === 0) return 'Less than a month';
  if (years === 0) return `${months} month${months > 1 ? 's' : ''}`;
  if (months === 0) return `${years} year${years > 1 ? 's' : ''}`;
  return `${years} year${years > 1 ? 's' : ''}, ${months} month${months > 1 ? 's' : ''}`;
}

// ─── GET /api/employee/public/:identityId ────────────────────────────────────
router.get("/public/:identityId", async (req, res) => {
  try {
    const { identityId } = req.params;

    console.log(`[PUBLIC-PROFILE-API] Searching for employee with identityId: ${identityId.toUpperCase()}`);

    // Find active employee by identityId (case-insensitive)
    const employee = await Employee.findOne({
      identityId: identityId.toUpperCase(),
      isActive: true
    })
      .select('firstName middleName lastName profilePhoto department designation jobTitle dateOfJoining workLocation identityId biometricId')
      .lean();

    console.log(`[PUBLIC-PROFILE-API] Employee found:`, !!employee);

    if (!employee) {
      // ALSO CHECK WITHOUT isActive filter to see if employee exists but is inactive
      const inactiveEmployee = await Employee.findOne({
        identityId: identityId.toUpperCase()
      }).select('identityId isActive').lean();

      console.log(`[PUBLIC-PROFILE-API] Inactive employee check:`, inactiveEmployee);

      return res.status(404).json({
        success: false,
        message: "Employee not found or inactive"
      });
    }

    // Calculate tenure
    const tenure = employee.dateOfJoining
      ? calculateEmployeeTenure(employee.dateOfJoining)
      : null;

    // Build response with public-safe data only
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