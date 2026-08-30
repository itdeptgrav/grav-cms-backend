const express = require("express");
const router = express.Router();
const JobPosting = require("../../models/HR_Models/JobPosting");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const Candidate = require("../../models/HR_Models/Candidates");
const EmployeeTask = require("../../models/HR_Models/EmployeeTask");

// Candidates share the Recruitment history with job postings - see the note in
// JobPosting_Section.js.
const { recordChange } = require("../../services/changeLog");
const auditCandidate = (req, entry) =>
  recordChange(req, {
    departmentSlug: "hr",
    section: "hr:recruitment",
    entity: "candidate",
    ...entry,
  });

/** Stage keys as the pipeline column headings spell them. */
const STAGE_LABELS = {
  screening: "Screening",
  technical_interview: "Technical interview",
  hr_interview: "HR interview",
  training: "Training",
  hired: "Hired",
  rejected: "Rejected",
};

const candidateSnapshot = (c) => ({
  name: c?.name,
  email: c?.email,
  phone: c?.phone,
  stage: c?.stage,
  status: c?.status,
  experience: c?.experience,
  expectedSalary: c?.expectedSalary,
  source: c?.source,
  notes: c?.notes,
  resumeUrl: c?.resumeUrl,
});

// ✅ GET candidates for a job posting
router.get("/:jobId", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { jobId } = req.params;
    const { stage, search } = req.query;

    // Build filter query
    let filter = { jobPostingId: jobId, status: "active" };

    if (stage && stage !== "all") {
      filter.stage = stage;
    }

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { jobTitle: { $regex: search, $options: "i" } },
      ];
    }

    const candidates = await Candidate.find(filter)
      .sort({ appliedDate: -1 })
      .lean();

    // Format response
    const formattedCandidates = candidates.map((candidate) => ({
      id: candidate._id,
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone,
      appliedDate: candidate.appliedDate,
      stage: candidate.stage,
      jobTitle: candidate.jobTitle,
      profilePic: candidate.profilePic,
      resumeUrl: candidate.resumeUrl,
      experience: candidate.experience,
      currentCompany: candidate.currentCompany,
      noticePeriod: candidate.noticePeriod,
      expectedSalary: candidate.expectedSalary,
      status: candidate.status,
      rating: candidate.rating,
      managerInCharge: candidate.managerInCharge?.managerName || "Not assigned",
    }));

    res.status(200).json({
      success: true,
      data: formattedCandidates,
    });
  } catch (error) {
    console.error("Get candidates error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching candidates",
    });
  }
});

// ✅ CREATE new candidate for a job posting
router.post("/:jobId/candidates", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { user } = req;
    const { jobId } = req.params;
    const candidateData = req.body;

    // Verify job posting exists
    const jobPosting = await JobPosting.findById(jobId);
    if (!jobPosting) {
      return res.status(404).json({
        success: false,
        message: "Job posting not found",
      });
    }

    // Check if candidate with same email already exists for this job
    const existingCandidate = await Candidate.findOne({
      jobPostingId: jobId,
      email: candidateData.email,
    });

    if (existingCandidate) {
      return res.status(400).json({
        success: false,
        message: "Candidate with this email already exists for this job",
      });
    }

    // Validate required fields
    if (!candidateData.name || !candidateData.email || !candidateData.phone) {
      return res.status(400).json({
        success: false,
        message: "Name, email, and phone are required",
      });
    }

    // Set job title from job posting
    candidateData.jobTitle = jobPosting.jobTitle;

    // Set created by
    candidateData.createdBy = user.id;

    // Create candidate
    const newCandidate = new Candidate(candidateData);
    await newCandidate.save();

    // Increment job posting applications count
    await JobPosting.findByIdAndUpdate(jobId, {
      $inc: { applications: 1 },
    });

    await auditCandidate(req, {
      entityId: String(newCandidate._id),
      entityLabel: `${newCandidate.name}${newCandidate.jobTitle ? ` - ${newCandidate.jobTitle}` : ""}`,
      action: "create",
      summary:
        `Added candidate ${newCandidate.name} to "${newCandidate.jobTitle || jobId}" ` +
        `at the ${STAGE_LABELS[newCandidate.stage] || newCandidate.stage || "screening"} stage` +
        `${newCandidate.source ? `, sourced from ${newCandidate.source}` : ""}.`,
      after: candidateSnapshot(newCandidate),
    });

    res.status(201).json({
      success: true,
      message: "Candidate added successfully",
      data: newCandidate,
    });
  } catch (error) {
    console.error("Create candidate error:", error);

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    res.status(500).json({
      success: false,
      message: "Error adding candidate",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ✅ UPDATE candidate stage
router.patch(
  "/:jobPostingId/candidates/:candidateId/stage",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { candidateId } = req.params;
      const { stage } = req.body;
      const { user } = req;

      // Validate stage transition
      const validStages = [
        "screening",
        "technical_interview",
        "hr_interview",
        "training",
        "hired",
        "rejected",
      ];

      if (!validStages.includes(stage)) {
        return res.status(400).json({
          success: false,
          message: "Invalid stage value",
        });
      }

      const candidate = await Candidate.findById(candidateId);
      if (!candidate) {
        return res.status(404).json({
          success: false,
          message: "Candidate not found",
        });
      }

      // If moving to hired, check if training is complete
      if (stage === "hired" && candidate.stage !== "training") {
        return res.status(400).json({
          success: false,
          message: "Candidate must complete training before being hired",
        });
      }

      // Read before the assignment. The console line below used to be written
      // after it and so printed the new stage on both sides of its own
      // "from X to Y".
      const previousStage = candidate.stage;
      const previousStatus = candidate.status;

      // Update candidate stage
      candidate.stage = stage;

      // If rejected, archive the candidate
      if (stage === "rejected") {
        candidate.status = "archived";
      }

      await candidate.save();

      // Log the stage change
      console.log(
        `Candidate ${candidate.name} stage changed from ${previousStage} to ${stage} by ${user.id}`,
      );

      await auditCandidate(req, {
        entityId: String(candidateId),
        entityLabel: `${candidate.name}${candidate.jobTitle ? ` - ${candidate.jobTitle}` : ""}`,
        action: stage === "hired" ? "approve" : stage === "rejected" ? "reject" : "update",
        summary:
          `Moved ${candidate.name} from ${STAGE_LABELS[previousStage] || previousStage} ` +
          `to ${STAGE_LABELS[stage] || stage}` +
          (stage === "rejected"
            ? " and archived the candidate."
            : stage === "hired"
              ? " - the candidate is hired."
              : "."),
        before: { stage: previousStage, status: previousStatus },
        after: { stage, status: candidate.status },
      });

      res.status(200).json({
        success: true,
        message: "Candidate stage updated successfully",
        data: candidate,
      });
    } catch (error) {
      console.error("Update candidate stage error:", error);
      res.status(500).json({
        success: false,
        message: "Error updating candidate stage",
      });
    }
  },
);

// ✅ DELETE candidate
router.delete(
  "/:jobId/candidates/:candidateId",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { candidateId } = req.params;

      const candidate = await Candidate.findById(candidateId);
      if (!candidate) {
        return res.status(404).json({
          success: false,
          message: "Candidate not found",
        });
      }

      // Soft delete by setting status to archived
      const previousStatus = candidate.status;
      candidate.status = "archived";
      await candidate.save();

      await auditCandidate(req, {
        entityId: String(candidateId),
        entityLabel: `${candidate.name}${candidate.jobTitle ? ` - ${candidate.jobTitle}` : ""}`,
        action: "delete",
        summary:
          `Removed candidate ${candidate.name} from the pipeline at the ` +
          `${STAGE_LABELS[candidate.stage] || candidate.stage} stage. ` +
          `The record was archived rather than deleted, so it can be restored.`,
        before: { status: previousStatus, stage: candidate.stage },
        after: { status: "archived" },
      });

      res.status(200).json({
        success: true,
        message: "Candidate deleted successfully",
      });
    } catch (error) {
      console.error("Delete candidate error:", error);
      res.status(500).json({
        success: false,
        message: "Error deleting candidate",
      });
    }
  },
);

// ✅ GET single candidate
router.get(
  "/:jobId/candidates/:candidateId",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { candidateId } = req.params;

      const candidate = await Candidate.findById(candidateId).lean();

      if (!candidate) {
        return res.status(404).json({
          success: false,
          message: "Candidate not found",
        });
      }

      res.status(200).json({
        success: true,
        data: candidate,
      });
    } catch (error) {
      console.error("Get candidate error:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching candidate",
      });
    }
  },
);

// ✅ UPDATE candidate
router.put(
  "/:jobId/candidates/:candidateId",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { user } = req;
      const { candidateId } = req.params;
      const updateData = req.body;

      // Check if candidate exists
      const existingCandidate = await Candidate.findById(candidateId);
      if (!existingCandidate) {
        return res.status(404).json({
          success: false,
          message: "Candidate not found",
        });
      }

      // Fields that should not be updated via this endpoint
      const restrictedFields = [
        "jobPostingId",
        "jobTitle",
        "createdBy",
        "createdAt",
      ];

      // Remove restricted fields
      restrictedFields.forEach((field) => {
        delete updateData[field];
      });

      const previousCandidate = await Candidate.findById(candidateId).lean();

      // Update candidate
      const updatedCandidate = await Candidate.findByIdAndUpdate(
        candidateId,
        updateData,
        {
          new: true,
          runValidators: true,
        },
      );

      await auditCandidate(req, {
        entityId: String(candidateId),
        entityLabel: `${updatedCandidate?.name || ""}${updatedCandidate?.jobTitle ? ` - ${updatedCandidate.jobTitle}` : ""}`,
        action: "update",
        before: candidateSnapshot(previousCandidate),
        after: candidateSnapshot(updatedCandidate),
      });

      res.status(200).json({
        success: true,
        message: "Candidate updated successfully",
        data: updatedCandidate,
      });
    } catch (error) {
      console.error("Update candidate error:", error);

      if (error.name === "ValidationError") {
        const errors = Object.values(error.errors).map((err) => err.message);
        return res.status(400).json({
          success: false,
          message: "Validation error",
          errors,
        });
      }

      res.status(500).json({
        success: false,
        message: "Error updating candidate",
      });
    }
  },
);

// ✅ UPDATE candidate interview questions
router.patch(
  "/:jobId/candidates/:candidateId/questions",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { user } = req;
      const { candidateId } = req.params;
      const { questions } = req.body;

      const candidate = await Candidate.findById(candidateId);
      if (!candidate) {
        return res.status(404).json({
          success: false,
          message: "Candidate not found",
        });
      }

      // Get user info
      const hrUser = await HRDepartment.findById(user.id)
        .select("name employeeId")
        .lean();
      const evaluatedBy = {
        name: hrUser?.name || "HR Manager",
        employeeId: hrUser?._id,
      };

      // Process questions
      const processedQuestions = questions.map((q) => ({
        ...q,
        evaluatedBy,
        evaluatedAt: new Date(),
      }));

      // Update candidate with new questions
      candidate.interviewQuestions = processedQuestions;
      await candidate.save();

      res.status(200).json({
        success: true,
        message: "Interview questions updated successfully",
        data: candidate,
      });
    } catch (error) {
      console.error("Update interview questions error:", error);
      res.status(500).json({
        success: false,
        message: "Error updating interview questions",
      });
    }
  },
);

// ✅ GET candidate with detailed information
router.get(
  "/:jobId/candidates/:candidateId/details",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { candidateId } = req.params;

      const candidate = await Candidate.findById(candidateId)
        .populate(
          "jobPostingId",
          "jobTitle jobLocation hiringManager commonQuestions",
        )
        .lean();

      if (!candidate) {
        return res.status(404).json({
          success: false,
          message: "Candidate not found",
        });
      }

      // Get job posting questions if not already in candidate
      if (
        !candidate.interviewQuestions ||
        candidate.interviewQuestions.length === 0
      ) {
        const jobPosting = await JobPosting.findById(candidate.jobPostingId)
          .select("commonQuestions")
          .lean();

        if (jobPosting && jobPosting.commonQuestions) {
          candidate.interviewQuestions = jobPosting.commonQuestions.map(
            (q, index) => ({
              question: q.question,
              order: q.order || index + 1,
              rating: 0,
              notes: "",
              stage: candidate.stage,
              evaluatedBy: null,
              evaluatedAt: null,
            }),
          );
        }
      }

      // Calculate rating
      let calculatedRating = 0;
      if (
        candidate.interviewQuestions &&
        candidate.interviewQuestions.length > 0
      ) {
        const questionsWithRatings = candidate.interviewQuestions.filter(
          (q) => q.rating > 0,
        );
        if (questionsWithRatings.length > 0) {
          const totalRating = questionsWithRatings.reduce(
            (sum, q) => sum + q.rating,
            0,
          );
          calculatedRating =
            Math.round((totalRating / questionsWithRatings.length) * 10) / 10;
        }
      }

      res.status(200).json({
        success: true,
        data: {
          ...candidate,
          calculatedRating,
        },
      });
    } catch (error) {
      console.error("Get candidate details error:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching candidate details",
      });
    }
  },
);

// ✅ ARCHIVE candidate (reject)
router.patch(
  "/:jobId/candidates/:candidateId/archive",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { candidateId } = req.params;
      const { reason } = req.body;

      const candidate = await Candidate.findById(candidateId);
      if (!candidate) {
        return res.status(404).json({
          success: false,
          message: "Candidate not found",
        });
      }

      // Archive candidate
      const previousStage = candidate.stage;
      const previousStatus = candidate.status;
      candidate.status = "archived";
      candidate.stage = "rejected";
      await candidate.save();

      await auditCandidate(req, {
        entityId: String(candidateId),
        entityLabel: `${candidate.name}${candidate.jobTitle ? ` - ${candidate.jobTitle}` : ""}`,
        action: "reject",
        summary:
          `Archived candidate ${candidate.name} out of the ` +
          `${STAGE_LABELS[previousStage] || previousStage} stage and marked them rejected.` +
          `${reason ? ` Reason: ${reason}` : " No reason was given."}`,
        before: { stage: previousStage, status: previousStatus },
        after: { stage: "rejected", status: "archived", reason: reason || "" },
      });

      res.status(200).json({
        success: true,
        message: "Candidate archived successfully",
      });
    } catch (error) {
      console.error("Archive candidate error:", error);
      res.status(500).json({
        success: false,
        message: "Error archiving candidate",
      });
    }
  },
);

router.get(
  "/:jobPostingId/candidates/:candidateId/interviews",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { candidateId } = req.params;

      const interviews = await EmployeeTask.find({
        candidateId,
        type: "interview",
      })
        .sort({ scheduledDate: -1 })
        .lean();

      res.status(200).json({
        success: true,
        data: interviews,
      });
    } catch (error) {
      console.error("Get candidate interviews error:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching interviews",
      });
    }
  },
);

module.exports = router;
