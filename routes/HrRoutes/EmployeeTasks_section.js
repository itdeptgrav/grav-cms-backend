const express = require("express");
const router = express.Router();
const EmployeeTask = require("../../models/HR_Models/EmployeeTask");
const Candidate = require("../../models/HR_Models/Candidates");
const JobPosting = require("../../models/HR_Models/JobPosting");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const HRDepartment = require("../../models/HRDepartment");

// Interview scheduling history. Filed under Recruitment, not its own page: an
// interview being moved or cancelled is part of that candidate's story and
// belongs beside their stage changes.
const { recordChange } = require("../../services/changeLog");
const auditTask = (req, entry) =>
  recordChange(req, {
    departmentSlug: "hr",
    section: "hr:recruitment",
    entity: "employee-task",
    ...entry,
  });

/** "Technical interview - Ramesh Kumar" */
const taskLabel = (t) =>
  [t?.title || t?.type, t?.candidateName || t?.employeeName].filter(Boolean).join(" - ") ||
  String(t?._id || "");

const taskSnapshot = (t) => ({
  title: t?.title,
  type: t?.type,
  status: t?.status,
  scheduledDate: t?.scheduledDate,
  scheduledTime: t?.scheduledTime,
  interviewStage: t?.interviewStage,
  location: t?.location,
  interviewers: t?.interviewers,
  notes: t?.notes,
  outcome: t?.outcome,
});

// ✅ CREATE new employee task (for scheduling meetings)
router.post("/", EmployeeAuthMiddleware, async (req, res) => {
  try {
    console.log("Creating new employee task...", req.body);

    const { user } = req;
    const taskData = req.body;

    // Validate required fields
    if (!taskData.title || !taskData.scheduledDate || !taskData.scheduledTime) {
      return res.status(400).json({
        success: false,
        message: "Title, scheduled date, and time are required",
      });
    }

    if (!taskData.candidateId) {
      return res.status(400).json({
        success: false,
        message: "Candidate ID is required",
      });
    }

    if (!taskData.jobPostingId) {
      return res.status(400).json({
        success: false,
        message: "Job posting ID is required",
      });
    }

    // Validate candidate exists
    const candidate = await Candidate.findById(taskData.candidateId);
    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: "Candidate not found",
      });
    }

    // Validate job posting exists
    const jobPosting = await JobPosting.findById(taskData.jobPostingId);
    if (!jobPosting) {
      return res.status(404).json({
        success: false,
        message: "Job posting not found",
      });
    }

    // Check if candidate already has a scheduled interview
    const existingInterview = await EmployeeTask.findOne({
      candidateId: taskData.candidateId,
      type: "interview",
      status: { $in: ["scheduled", "in_progress"] },
    });

    if (existingInterview) {
      return res.status(400).json({
        success: false,
        message: "Candidate already has a scheduled interview",
        existingInterview: {
          id: existingInterview._id,
          scheduledDate: existingInterview.scheduledDate,
          scheduledTime: existingInterview.scheduledTime,
        },
      });
    }

    // Get user's name
    const hrUser = await HRDepartment.findById(user.id).select("name").lean();
    const userName = hrUser?.name || "HR Manager";

    // Add system fields
    taskData.createdBy = user.id;
    taskData.createdByName = userName;
    taskData.type = taskData.type || "interview";
    taskData.status = "scheduled";

    // Make sure candidate stage is updated in the task
    if (!taskData.interviewStage && candidate.stage) {
      taskData.interviewStage = candidate.stage;
    }

    // Ensure participants array has both interviewer and interviewee
    if (!taskData.participants || taskData.participants.length === 0) {
      taskData.participants = [
        {
          name: candidate.name,
          email: candidate.email,
          role: "interviewee",
          status: "invited",
        },
        {
          employeeId: user.id,
          name: userName,
          email: hrUser?.email || "",
          role: "interviewer",
          status: "invited",
        },
      ];
    }

    console.log("Task data to save:", taskData);

    // Create task
    const newTask = new EmployeeTask(taskData);
    await newTask.save();

    // Update candidate stage if it's an interview task
    if (taskData.type === "interview" && taskData.interviewStage) {
      await Candidate.findByIdAndUpdate(taskData.candidateId, {
        stage: taskData.interviewStage,
      });
      console.log(`Updated candidate stage to: ${taskData.interviewStage}`);
    }

    await auditTask(req, {
      entityId: String(newTask._id),
      entityLabel: taskLabel(newTask),
      action: "create",
      summary:
        `Scheduled a ${newTask.type || "task"} for ` +
        `${String(newTask.scheduledDate).slice(0, 10)}${newTask.scheduledTime ? ` at ${newTask.scheduledTime}` : ""}` +
        `${taskData.interviewStage ? `. The candidate was moved to the ${taskData.interviewStage} stage by this booking` : ""}.`,
      after: taskSnapshot(newTask),
    });

    res.status(201).json({
      success: true,
      message: "Interview scheduled successfully",
      data: newTask,
    });
  } catch (error) {
    console.error("Create employee task error:", error);

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
      message: "Error scheduling interview",
      error: error.message,
    });
  }
});

// ✅ GET tasks for a candidate
router.get(
  "/candidate/:candidateId",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      const { candidateId } = req.params;
      const { status, type } = req.query;

      let filter = { candidateId };

      if (status && status !== "all") {
        filter.status = status;
      }

      if (type && type !== "all") {
        filter.type = type;
      }

      const tasks = await EmployeeTask.find(filter)
        .populate("candidateId", "name email phone stage")
        .populate("jobPostingId", "jobTitle jobLocation")
        .sort({ scheduledDate: 1, scheduledTime: 1 })
        .lean();

      // Check if candidate has any scheduled interviews
      const hasScheduledInterview = tasks.some(
        (task) => task.type === "interview" && task.status === "scheduled",
      );

      res.status(200).json({
        success: true,
        data: tasks,
        hasScheduledInterview,
      });
    } catch (error) {
      console.error("Get candidate tasks error:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching tasks",
      });
    }
  },
);

// ✅ GET tasks for a manager
router.get("/manager/:managerId", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { managerId } = req.params;
    const { status, fromDate, toDate } = req.query;

    let filter = { managerId };

    if (status && status !== "all") {
      filter.status = status;
    }

    if (fromDate && toDate) {
      filter.scheduledDate = {
        $gte: new Date(fromDate),
        $lte: new Date(toDate),
      };
    }

    const tasks = await EmployeeTask.find(filter)
      .populate("candidateId", "name email phone")
      .populate("jobPostingId", "jobTitle jobLocation")
      .sort({ scheduledDate: 1, scheduledTime: 1 })
      .lean();

    res.status(200).json({
      success: true,
      data: tasks,
    });
  } catch (error) {
    console.error("Get manager tasks error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching tasks",
    });
  }
});

// ✅ UPDATE task status
router.patch("/:taskId/status", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { status } = req.body;

    const validStatuses = [
      "scheduled",
      "in_progress",
      "completed",
      "cancelled",
      "rescheduled",
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value",
      });
    }

    const updateData = { status };

    // Set completion/cancellation timestamps
    if (status === "completed") {
      updateData.completedAt = new Date();
    } else if (status === "cancelled") {
      updateData.cancelledAt = new Date();
    } else if (status === "rescheduled") {
      updateData.rescheduledAt = new Date();
    }

    const previousTask = await EmployeeTask.findById(taskId).lean();

    const updatedTask = await EmployeeTask.findByIdAndUpdate(
      taskId,
      updateData,
      { new: true },
    );

    if (!updatedTask) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    await auditTask(req, {
      entityId: String(taskId),
      entityLabel: taskLabel(updatedTask),
      action: "update",
      summary:
        `Moved ${taskLabel(updatedTask)} from ${previousTask?.status || "unknown"} to ${status}.`,
      before: { status: previousTask?.status },
      after: { status },
    });

    res.status(200).json({
      success: true,
      message: "Task status updated successfully",
      data: updatedTask,
    });
  } catch (error) {
    console.error("Update task status error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating task status",
    });
  }
});

// ✅ UPDATE task (reschedule)
router.put("/:taskId", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { taskId } = req.params;
    const updateData = req.body;

    const task = await EmployeeTask.findById(taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // If rescheduling, update the status
    if (updateData.scheduledDate || updateData.scheduledTime) {
      updateData.status = "rescheduled";
      updateData.rescheduledAt = new Date();
    }

    const updatedTask = await EmployeeTask.findByIdAndUpdate(
      taskId,
      updateData,
      { new: true, runValidators: true },
    );

    // `task` was read at the top of the handler for the existence check, so it
    // is a genuine pre-write snapshot.
    await auditTask(req, {
      entityId: String(taskId),
      entityLabel: taskLabel(updatedTask),
      action: "update",
      before: taskSnapshot(task),
      after: taskSnapshot(updatedTask),
    });

    res.status(200).json({
      success: true,
      message: "Task updated successfully",
      data: updatedTask,
    });
  } catch (error) {
    console.error("Update task error:", error);

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
      message: "Error updating task",
    });
  }
});

// ✅ DELETE task
router.delete("/:taskId", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await EmployeeTask.findById(taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    await EmployeeTask.findByIdAndDelete(taskId);

    // A hard delete - nothing survives but this entry.
    await auditTask(req, {
      entityId: String(taskId),
      entityLabel: taskLabel(task),
      action: "delete",
      summary:
        `Deleted the ${task.type || "task"} that was scheduled for ` +
        `${String(task.scheduledDate).slice(0, 10)}${task.scheduledTime ? ` at ${task.scheduledTime}` : ""} ` +
        `(status ${task.status}). The record is gone, not archived.`,
      before: taskSnapshot(task),
    });

    res.status(200).json({
      success: true,
      message: "Task deleted successfully",
    });
  } catch (error) {
    console.error("Delete task error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting task",
    });
  }
});

// ✅ GET upcoming tasks for dashboard
router.get("/upcoming/tasks", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { user } = req;
    const { limit = 10 } = req.query;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);

    const tasks = await EmployeeTask.find({
      status: "scheduled",
      scheduledDate: { $gte: today, $lte: nextWeek },
    })
      .populate("candidateId", "name email")
      .populate("jobPostingId", "jobTitle")
      .sort({ scheduledDate: 1, scheduledTime: 1 })
      .limit(parseInt(limit))
      .lean();

    res.status(200).json({
      success: true,
      data: tasks,
    });
  } catch (error) {
    console.error("Get upcoming tasks error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching upcoming tasks",
    });
  }
});

router.patch("/:taskId/complete", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { outcome, outcomeNotes, candidateRating } = req.body;
    const { user } = req;

    const task = await EmployeeTask.findById(taskId).populate(
      "jobPostingId",
      "technicalRole",
    );

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Update task status
    task.status = "completed";
    task.completedAt = new Date();
    task.outcome = outcome || "pending";
    task.outcomeNotes = outcomeNotes || "";

    // Get HR user info
    const hrUser = await HRDepartment.findById(user.id).select("name").lean();
    const userName = hrUser?.name || "HR Manager";

    // Update candidate stage based on interview completion
    const candidate = await Candidate.findById(task.candidateId);
    if (candidate) {
      const currentStage = task.interviewStage;
      const isTechnicalRole = task.jobPostingId?.technicalRole || false;

      let nextStage = null;

      if (currentStage === "screening") {
        nextStage = isTechnicalRole ? "technical_interview" : "hr_interview";
      } else if (currentStage === "technical_interview") {
        nextStage = "hr_interview";
      } else if (currentStage === "hr_interview") {
        nextStage = "training";
      }

      if (nextStage && outcome === "positive") {
        candidate.stage = nextStage;
        console.log(`Candidate ${candidate.name} moved to ${nextStage} stage`);
      } else if (outcome === "negative") {
        candidate.stage = "rejected";
        candidate.status = "archived";
      }

      // Update candidate rating if provided
      if (candidateRating) {
        // Add interview question rating
        const question = {
          question: `Interview feedback for ${currentStage}`,
          rating: candidateRating,
          notes: outcomeNotes,
          stage: currentStage,
          evaluatedBy: {
            name: userName,
            employeeId: user.id,
          },
          evaluatedAt: new Date(),
        };

        if (!candidate.interviewQuestions) {
          candidate.interviewQuestions = [];
        }
        candidate.interviewQuestions.push(question);
      }

      await candidate.save();
    }

    await task.save();

    await auditTask(req, {
      entityId: String(taskId),
      entityLabel: taskLabel(task),
      action: "update",
      summary:
        `Completed the ${task.interviewStage || task.type || "task"} with an outcome of ` +
        `"${task.outcome}"` +
        `${candidateRating != null ? ` and a rating of ${candidateRating}` : ""}` +
        `${candidate ? `. The candidate is now at the ${candidate.stage} stage.` : "."}` +
        `${outcomeNotes ? ` Notes: ${outcomeNotes}` : ""}`,
      before: { status: "scheduled", outcome: "" },
      after: {
        status: "completed",
        outcome: task.outcome,
        outcomeNotes: task.outcomeNotes,
        candidateStage: candidate?.stage,
      },
    });

    res.status(200).json({
      success: true,
      message: "Interview completed successfully",
      data: task,
    });
  } catch (error) {
    console.error("Complete interview error:", error);
    res.status(500).json({
      success: false,
      message: "Error completing interview",
    });
  }
});

module.exports = router;
