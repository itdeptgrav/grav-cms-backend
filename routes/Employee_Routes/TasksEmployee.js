const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const EmployeeTask = require("../../models/HR_Models/EmployeeTask");
const Candidate = require("../../models/HR_Models/Candidates");
const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");

// ✅ GET tasks for logged-in employee (for employee app)
router.get("/my-tasks", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const { user } = req;
    const { status, type } = req.query;

    console.log("Employee App - Fetching tasks for user ID:", user.id);
    console.log("User email:", user.email);
    console.log("User type:", user.type);

    // Build filter for tasks where employee is a participant
    let filter = {
      $or: [
        { "participants.employeeId": user.id }, // Direct match
        { "participants.employeeId": new mongoose.Types.ObjectId(user.id) }, // As ObjectId
        { "participants.employeeId": user.id.toString() }, // As string
      ],
    };

    if (status && status !== "all") {
      filter.status = status;
    }

    if (type && type !== "all") {
      filter.type = type;
    }

    // Add date filter for upcoming tasks (next 7 days)
    if (!status || status === "scheduled") {
      const today = new Date();
      const nextWeek = new Date();
      nextWeek.setDate(today.getDate() + 7);

      filter.scheduledDate = {
        $gte: today,
        $lte: nextWeek,
      };
    }

    console.log("Employee Task Filter:", JSON.stringify(filter, null, 2));

    const tasks = await EmployeeTask.find(filter)
      .populate("candidateId", "name email phone stage rating profilePic")
      .populate(
        "jobPostingId",
        "jobTitle jobLocation description commonQuestions technicalRole",
      )
      .populate("departmentId", "name")
      .sort({ scheduledDate: 1, scheduledTime: 1 })
      .lean();

    console.log(`Employee App - Found ${tasks.length} tasks`);

    // Format tasks for frontend
    const formattedTasks = tasks.map((task) => {
      const candidate = task.candidateId;
      const job = task.jobPostingId;

      // Find participant - handle all ID formats
      const participant = task.participants?.find((p) => {
        if (!p.employeeId) return false;

        // Compare as strings
        const employeeIdStr = p.employeeId.toString();
        const userIdStr = user.id.toString();

        return employeeIdStr === userIdStr;
      });

      return {
        id: task._id,
        title: task.title,
        description: task.description,
        type: task.type,
        status: task.status,
        scheduledDate: task.scheduledDate,
        scheduledTime: task.scheduledTime,
        duration: task.duration,
        location: task.location,
        interviewStage: task.interviewStage,
        interviewType: task.interviewType,
        outcome: task.outcome,
        outcomeNotes: task.outcomeNotes,
        candidateId: candidate?._id,
        candidateName: candidate?.name,
        candidateEmail: candidate?.email,
        candidatePhone: candidate?.phone,
        candidateStage: candidate?.stage,
        candidateRating: candidate?.rating,
        candidatePhoto: candidate?.profilePic?.url,
        jobPostingId: job?._id,
        jobTitle: job?.jobTitle,
        jobLocation: job?.jobLocation,
        jobDescription: job?.description,
        commonQuestions: job?.commonQuestions || [],
        technicalRole: job?.technicalRole,
        departmentName: task.departmentName,
        role: participant?.role,
        createdByName: task.createdByName,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        // Virtual fields
        isOverdue: task.isOverdue,
        isUpcoming: task.isUpcoming,
        scheduledDateTime: task.scheduledDateTime,
      };
    });

    res.status(200).json({
      success: true,
      data: formattedTasks,
    });
  } catch (error) {
    console.error("Employee App - Get tasks error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching tasks",
      error: error.message,
    });
  }
});

// ✅ GET single task details for employee
router.get("/task/:taskId", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { user } = req;

    console.log(
      "Employee App - Fetching task details:",
      taskId,
      "for user:",
      user.id,
    );

    const task = await EmployeeTask.findById(taskId)
      .populate(
        "candidateId",
        "name email phone experience currentCompany noticePeriod expectedSalary stage rating interviewQuestions profilePic",
      )
      .populate(
        "jobPostingId",
        "jobTitle jobLocation description commonQuestions requiredSkills experienceRequired salaryRange hiringManager technicalRole",
      )
      .populate("departmentId", "name")
      .lean();

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Check if user is a participant - handle all ID formats
    const isParticipant = task.participants?.some((p) => {
      if (!p.employeeId) return false;

      // Compare as strings
      const employeeIdStr = p.employeeId.toString();
      const userIdStr = user.id.toString();

      return employeeIdStr === userIdStr;
    });

    if (!isParticipant) {
      console.log("Employee App - User not a participant");
      console.log("Task Participants:", task.participants);
      console.log("User ID:", user.id);
      return res.status(403).json({
        success: false,
        message: "You don't have permission to view this task",
      });
    }

    // Get candidate's existing interview questions for this stage
    const existingQuestions =
      task.candidateId?.interviewQuestions?.filter(
        (q) => q.stage === task.interviewStage,
      ) || [];

    // Merge with common questions from job posting
    const commonQuestions = task.jobPostingId?.commonQuestions || [];
    const interviewQuestions = commonQuestions.map((question, index) => {
      const existing = existingQuestions.find(
        (q) => q.question === question.question,
      );
      return {
        id: `question-${index}`,
        question: question.question,
        order: question.order,
        rating: existing?.rating || 0,
        notes: existing?.notes || "",
        stage: task.interviewStage,
        evaluatedBy: existing?.evaluatedBy,
        evaluatedAt: existing?.evaluatedAt,
      };
    });

    const formattedTask = {
      id: task._id,
      title: task.title,
      description: task.description,
      type: task.type,
      status: task.status,
      scheduledDate: task.scheduledDate,
      scheduledTime: task.scheduledTime,
      duration: task.duration,
      location: task.location,
      meetingLink: task.meetingLink,
      interviewStage: task.interviewStage,
      interviewType: task.interviewType,
      outcome: task.outcome,
      outcomeNotes: task.outcomeNotes,

      // Candidate Information
      candidate: {
        id: task.candidateId?._id,
        name: task.candidateId?.name,
        email: task.candidateId?.email,
        phone: task.candidateId?.phone,
        experience: task.candidateId?.experience,
        currentCompany: task.candidateId?.currentCompany,
        noticePeriod: task.candidateId?.noticePeriod,
        expectedSalary: task.candidateId?.expectedSalary,
        stage: task.candidateId?.stage,
        rating: task.candidateId?.rating,
        profilePic: task.candidateId?.profilePic?.url,
      },

      // Job Information
      job: {
        id: task.jobPostingId?._id,
        title: task.jobPostingId?.jobTitle,
        location: task.jobPostingId?.jobLocation,
        description: task.jobPostingId?.description,
        requiredSkills: task.jobPostingId?.requiredSkills || [],
        experienceRequired: task.jobPostingId?.experienceRequired || {},
        salaryRange: task.jobPostingId?.salaryRange || {},
        hiringManager: task.jobPostingId?.hiringManager || {},
        technicalRole: task.jobPostingId?.technicalRole,
      },

      // Interview Questions
      interviewQuestions,

      // Department
      departmentName: task.departmentName,
      designation: task.designation,

      // System Information
      createdByName: task.createdByName,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,

      // Participant Information
      participantRole: task.participants?.find((p) => {
        if (!p.employeeId) return false;
        return p.employeeId.toString() === user.id.toString();
      })?.role,
    };

    res.status(200).json({
      success: true,
      data: formattedTask,
    });
  } catch (error) {
    console.error("Employee App - Get task details error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching task details",
      error: error.message,
    });
  }
});

// ✅ SUBMIT interview feedback
router.post("/:taskId/feedback", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { user } = req;
    const { questions, decision } = req.body;

    console.log("Employee App - Submitting feedback for task:", taskId);
    console.log("User:", user.id, "Decision:", decision);

    // Validate required fields
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({
        success: false,
        message: "Interview questions are required",
      });
    }

    if (!decision || !["positive", "negative"].includes(decision)) {
      return res.status(400).json({
        success: false,
        message: "Valid decision is required (positive or negative)",
      });
    }

    const task = await EmployeeTask.findById(taskId)
      .populate("candidateId")
      .populate("jobPostingId");

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Check if user is a participant and is interviewer
    const participant = task.participants?.find((p) => {
      if (!p.employeeId) return false;
      return p.employeeId.toString() === user.id.toString();
    });

    if (!participant || participant.role !== "interviewer") {
      return res.status(403).json({
        success: false,
        message: "Only interviewers can submit feedback",
      });
    }

    // Calculate overall rating from questions
    const validQuestions = questions.filter((q) => q.rating > 0);
    const overallRating =
      validQuestions.length > 0
        ? Math.round(
            (validQuestions.reduce((sum, q) => sum + q.rating, 0) /
              validQuestions.length) *
              10,
          ) / 10
        : 0;

    // Combine all notes from questions
    const overallNotes = questions
      .filter((q) => q.notes && q.notes.trim())
      .map((q) => `${q.question}: ${q.notes}`)
      .join("\n");

    // Update candidate interview questions
    const interviewQuestions = questions.map((q) => ({
      question: q.question,
      rating: q.rating || 0,
      notes: q.notes || "",
      stage: task.interviewStage,
      evaluatedBy: {
        name: user.email || "Interviewer",
        employeeId: user.id,
      },
      evaluatedAt: new Date(),
    }));

    // Update candidate
    const candidate = task.candidateId;
    if (candidate) {
      // Add new interview questions
      if (!candidate.interviewQuestions) {
        candidate.interviewQuestions = [];
      }

      // Remove existing questions for this stage from this interviewer
      candidate.interviewQuestions = candidate.interviewQuestions.filter(
        (q) =>
          !(
            q.stage === task.interviewStage &&
            q.evaluatedBy?.employeeId?.toString() === user.id.toString()
          ),
      );

      // Add new questions
      candidate.interviewQuestions.push(...interviewQuestions);

      // Update overall rating (weighted average of all questions)
      const allQuestions = candidate.interviewQuestions.filter(
        (q) => q.rating > 0,
      );
      if (allQuestions.length > 0) {
        candidate.rating =
          Math.round(
            (allQuestions.reduce((sum, q) => sum + q.rating, 0) /
              allQuestions.length) *
              10,
          ) / 10;
      } else {
        candidate.rating = overallRating;
      }

      await candidate.save();
    }

    // Update task status and outcome
    task.status = "completed";
    task.completedAt = new Date();
    task.outcome = decision;
    task.outcomeNotes = overallNotes;

    // Determine next stage based on decision
    if (decision === "positive") {
      // Auto-determine next stage based on current stage
      const currentStage = task.interviewStage;
      let nextStageValue = null;

      if (currentStage === "screening") {
        // Screening goes to either technical or HR based on role
        const isTechnicalRole = task.jobPostingId?.technicalRole || false;
        nextStageValue = isTechnicalRole
          ? "technical_interview"
          : "hr_interview";
      } else if (
        currentStage === "technical_interview" ||
        currentStage === "hr_interview"
      ) {
        // Both technical and HR interviews go directly to training
        nextStageValue = "training";
      } else if (currentStage === "training") {
        // Training goes to hired
        nextStageValue = "hired";
      }

      if (nextStageValue && candidate) {
        candidate.stage = nextStageValue;
        await candidate.save();
        console.log(
          `Candidate ${candidate.name} moved to ${nextStageValue} stage`,
        );
      }
    } else if (decision === "negative" && candidate) {
      // If negative decision, reject candidate
      candidate.stage = "rejected";
      candidate.status = "archived";
      await candidate.save();
      console.log(`Candidate ${candidate.name} rejected`);
    }

    await task.save();

    res.status(200).json({
      success: true,
      message: "Feedback submitted successfully",
      data: {
        taskId: task._id,
        candidateId: candidate?._id,
        candidateStage: candidate?.stage,
        candidateRating: candidate?.rating,
        nextStage: candidate?.stage,
      },
    });
  } catch (error) {
    console.error("Employee App - Submit feedback error:", error);
    res.status(500).json({
      success: false,
      message: "Error submitting feedback",
      error: error.message,
    });
  }
});

// ✅ UPDATE task status
router.patch(
  "/task/:taskId/status",
  AllEmployeeAppMiddleware,
  async (req, res) => {
    try {
      const { taskId } = req.params;
      const { user } = req;
      const { status } = req.body;

      const validStatuses = [
        "scheduled",
        "in_progress",
        "completed",
        "cancelled",
      ];

      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status value",
        });
      }

      const task = await EmployeeTask.findById(taskId);

      if (!task) {
        return res.status(404).json({
          success: false,
          message: "Task not found",
        });
      }

      // Check if user is a participant
      const isParticipant = task.participants?.some((p) => {
        if (!p.employeeId) return false;
        return p.employeeId.toString() === user.id.toString();
      });

      if (!isParticipant) {
        return res.status(403).json({
          success: false,
          message: "You don't have permission to update this task",
        });
      }

      const updateData = { status };

      // Set timestamps
      if (status === "completed") {
        updateData.completedAt = new Date();
      } else if (status === "cancelled") {
        updateData.cancelledAt = new Date();
      }

      const updatedTask = await EmployeeTask.findByIdAndUpdate(
        taskId,
        updateData,
        { new: true },
      );

      res.status(200).json({
        success: true,
        message: `Task ${status} successfully`,
        data: updatedTask,
      });
    } catch (error) {
      console.error("Employee App - Update task status error:", error);
      res.status(500).json({
        success: false,
        message: "Error updating task status",
      });
    }
  },
);

// ✅ DEBUG: Get user info for testing
router.get("/debug/user-info", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const { user } = req;

    res.status(200).json({
      success: true,
      data: {
        userId: user.id,
        userIdType: typeof user.id,
        userEmail: user.email,
        userType: user.type,
        user: user,
      },
    });
  } catch (error) {
    console.error("Debug error:", error);
    res.status(500).json({
      success: false,
      message: "Debug error",
      error: error.message,
    });
  }
});

// ✅ DEBUG: Get all tasks (for testing)
router.get("/debug/all-tasks", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const tasks = await EmployeeTask.find({})
      .populate("candidateId", "name")
      .lean();

    const formattedTasks = tasks.map((task) => ({
      id: task._id,
      title: task.title,
      participants: task.participants?.map((p) => ({
        employeeId: p.employeeId,
        employeeIdType: typeof p.employeeId,
        name: p.name,
        role: p.role,
      })),
      scheduledDate: task.scheduledDate,
    }));

    res.status(200).json({
      success: true,
      data: formattedTasks,
    });
  } catch (error) {
    console.error("Debug error:", error);
    res.status(500).json({
      success: false,
      message: "Debug error",
      error: error.message,
    });
  }
});

module.exports = router;
