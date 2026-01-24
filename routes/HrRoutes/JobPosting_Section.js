const express = require("express");
const router = express.Router();
const JobPosting = require("../../models/HR_Models/JobPosting");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const HRDepartment = require("../../models/HRDepartment");

// ✅ CREATE new job posting
router.post("/", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { user } = req;
    const jobData = req.body;

    // Get user's name from database or use default
    const hrUser = await HRDepartment.findById(user.id).select("name").lean();
    const userName = hrUser?.name || "HR Manager";

    // Add created by information
    jobData.createdBy = user.id;
    jobData.createdByName = userName;
    jobData.publishedAt = new Date();

    // Validate required fields
    if (jobData.technicalRole === undefined) {
      return res.status(400).json({
        success: false,
        message: "Technical role selection is required",
      });
    }

    // Validate last date is in the future
    if (new Date(jobData.lastDate) <= new Date()) {
      return res.status(400).json({
        success: false,
        message: "Last date must be in the future",
      });
    }

    // Validate positions open
    if (jobData.positionsOpen <= 0) {
      return res.status(400).json({
        success: false,
        message: "Positions open must be at least 1",
      });
    }

    // Validate common questions have proper order
    if (jobData.commonQuestions && Array.isArray(jobData.commonQuestions)) {
      jobData.commonQuestions = jobData.commonQuestions.map((q, index) => ({
        ...q,
        order: index + 1,
      }));
    }

    const newJobPosting = new JobPosting(jobData);
    await newJobPosting.save();

    res.status(201).json({
      success: true,
      message: "Job posting created successfully",
      data: newJobPosting,
    });
  } catch (error) {
    console.error("Create job posting error:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Duplicate job posting",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error creating job posting",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ✅ GET job postings for dashboard (with status mapping)
router.get("/dashboard/jobs", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { status } = req.query;

    // Map frontend status to backend status
    const statusMap = {
      all: null,
      open: "published",
      hold: "archived",
      closed: "closed",
      draft: "draft",
    };

    // Build filter query
    let filter = {};

    if (status && status !== "all") {
      filter.status = statusMap[status];
    }

    // Get job postings sorted by creation date
    const jobPostings = await JobPosting.find(filter)
      .sort({ createdAt: -1 })
      .select(
        "jobTitle jobLocation lastDate positionsOpen status createdByName hiringManager applications technicalRole",
      )
      .lean();

    // Format the response to match frontend UI
    const formattedJobs = jobPostings.map((job, index) => {
      // Map backend status to frontend status
      const frontendStatus =
        Object.keys(statusMap).find((key) => statusMap[key] === job.status) ||
        "draft";

      // Format date
      const postedDate = new Date(job.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

      // Format positions
      const positions =
        job.positionsOpen === 1
          ? "1 Position"
          : `${job.positionsOpen} Positions`;

      return {
        id: job._id,
        title: job.jobTitle,
        status: frontendStatus,
        location: job.jobLocation,
        postedDate: postedDate,
        positions: positions,
        createdBy: job.createdByName || "HR Manager",
        applications: job.applications || 0,
        hiringManager: job.hiringManager?.managerName || "Not Assigned",
        lastDate: new Date(job.lastDate).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        technicalRole: job.technicalRole || false,
      };
    });

    // Get counts for tabs
    const allJobs = await JobPosting.countDocuments();
    const publishedJobs = await JobPosting.countDocuments({
      status: "published",
    });
    const archivedJobs = await JobPosting.countDocuments({
      status: "archived",
    });
    const closedJobs = await JobPosting.countDocuments({ status: "closed" });
    const draftJobs = await JobPosting.countDocuments({ status: "draft" });

    res.status(200).json({
      success: true,
      data: {
        jobs: formattedJobs,
        counts: {
          all: allJobs,
          open: publishedJobs,
          hold: archivedJobs,
          closed: closedJobs,
          draft: draftJobs,
        },
      },
    });
  } catch (error) {
    console.error("Get dashboard jobs error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching dashboard jobs",
    });
  }
});

// ✅ GET quick stats for dashboard
router.get("/dashboard/stats", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const stats = await JobPosting.aggregate([
      {
        $facet: {
          totalJobs: [{ $count: "count" }],
          activeJobs: [
            {
              $match: {
                status: "published",
                lastDate: { $gt: new Date() },
              },
            },
            { $count: "count" },
          ],
          todaysApplications: [
            {
              $match: {
                createdAt: {
                  $gte: new Date(new Date().setHours(0, 0, 0, 0)),
                  $lt: new Date(new Date().setHours(23, 59, 59, 999)),
                },
              },
            },
            { $count: "count" },
          ],
          totalApplications: [
            {
              $group: {
                _id: null,
                total: { $sum: "$applications" },
              },
            },
          ],
        },
      },
    ]);

    const result = stats[0];

    res.status(200).json({
      success: true,
      data: {
        totalJobs: result.totalJobs[0]?.count || 0,
        activeJobs: result.activeJobs[0]?.count || 0,
        todaysApplications: result.todaysApplications[0]?.count || 0,
        totalApplications: result.totalApplications[0]?.total || 0,
      },
    });
  } catch (error) {
    console.error("Get dashboard stats error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching dashboard stats",
    });
  }
});

// ✅ GET single job posting by ID
router.get("/:id", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const jobPosting = await JobPosting.findById(id).lean();

    if (!jobPosting) {
      return res.status(404).json({
        success: false,
        message: "Job posting not found",
      });
    }

    // Increment views
    await JobPosting.findByIdAndUpdate(id, { $inc: { views: 1 } });

    // Add virtual fields
    const jobWithVirtuals = {
      ...jobPosting,
      isActive:
        jobPosting.status === "published" &&
        new Date() <= new Date(jobPosting.lastDate),
      daysRemaining: Math.ceil(
        (new Date(jobPosting.lastDate) - new Date()) / (1000 * 60 * 60 * 24),
      ),
    };

    res.status(200).json({
      success: true,
      data: jobWithVirtuals,
    });
  } catch (error) {
    console.error("Get job posting error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid job posting ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error fetching job posting",
    });
  }
});

// ✅ UPDATE job posting
router.put("/:id", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { user } = req;
    const { id } = req.params;
    const updateData = req.body;

    // Check if job posting exists
    const existingJob = await JobPosting.findById(id);
    if (!existingJob) {
      return res.status(404).json({
        success: false,
        message: "Job posting not found",
      });
    }

    // Validate last date if being updated
    if (updateData.lastDate && new Date(updateData.lastDate) <= new Date()) {
      return res.status(400).json({
        success: false,
        message: "Last date must be in the future",
      });
    }

    // Add updated by information
    updateData.updatedBy = user.id;

    const updatedJob = await JobPosting.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });

    res.status(200).json({
      success: true,
      message: "Job posting updated successfully",
      data: updatedJob,
    });
  } catch (error) {
    console.error("Update job posting error:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid job posting ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating job posting",
    });
  }
});

// ✅ DELETE job posting (soft delete by changing status)
router.delete("/:id", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const jobPosting = await JobPosting.findById(id);
    if (!jobPosting) {
      return res.status(404).json({
        success: false,
        message: "Job posting not found",
      });
    }

    // Archive instead of hard delete
    jobPosting.status = "archived";
    await jobPosting.save();

    res.status(200).json({
      success: true,
      message: "Job posting archived successfully",
    });
  } catch (error) {
    console.error("Delete job posting error:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid job posting ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error archiving job posting",
    });
  }
});

// ✅ CHANGE STATUS of job posting
router.patch("/:id/status", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["draft", "published", "closed", "archived"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value",
      });
    }

    const jobPosting = await JobPosting.findById(id);
    if (!jobPosting) {
      return res.status(404).json({
        success: false,
        message: "Job posting not found",
      });
    }

    jobPosting.status = status;
    if (status === "published") {
      jobPosting.publishedAt = new Date();
    } else if (status === "closed") {
      jobPosting.closedAt = new Date();
    }

    await jobPosting.save();

    res.status(200).json({
      success: true,
      message: `Job posting ${status} successfully`,
      data: jobPosting,
    });
  } catch (error) {
    console.error("Change status error:", error);
    res.status(500).json({
      success: false,
      message: "Error changing job posting status",
    });
  }
});

module.exports = router;
