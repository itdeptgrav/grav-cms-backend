const mongoose = require("mongoose");

const employeeTaskSchema = new mongoose.Schema(
  {
    // Task Information
    title: {
      type: String,
      required: [true, "Task title is required"],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      enum: ["interview", "meeting", "followup", "review", "other"],
      default: "interview",
    },

    // Related Entities
    candidateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Candidate",
      required: true,
    },
    jobPostingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JobPosting",
      required: true,
    },
    // Removed jobId field since we only need jobPostingId

    // Department & Manager Information
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
    },
    departmentName: {
      type: String,
    },
    designation: {
      type: String,
    },
    // Removed managerId and managerName as they should be in participants

    // Scheduling Information
    scheduledDate: {
      type: Date,
      required: true,
    },
    scheduledTime: {
      type: String,
      required: true,
    },
    duration: {
      type: Number, // in minutes
      default: 60,
    },
    location: {
      type: String,
      trim: true,
    },
    meetingRoom: {
      type: String,
      trim: true,
    },
    meetingLink: {
      type: String,
      trim: true,
    },

    // Remarks
    remarks: {
      type: String,
      trim: true,
    },

    // Task Status
    status: {
      type: String,
      enum: [
        "scheduled",
        "in_progress",
        "completed",
        "cancelled",
        "rescheduled",
      ],
      default: "scheduled",
    },
    // Removed priority field

    // Interview Specific Fields
    interviewStage: {
      type: String,
      enum: ["screening", "technical_interview", "hr_interview", "final"],
    },
    interviewType: {
      type: String,
      enum: ["in_person", "virtual", "phone"],
      default: "in_person",
    },

    // Participants - Should include both interviewer and interviewee
    participants: [
      {
        employeeId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
        },
        name: String,
        email: String,
        role: String, // "interviewer" or "interviewee"
        status: {
          type: String,
          enum: ["invited", "accepted", "declined", "tentative"],
          default: "invited",
        },
      },
    ],

    // Outcome
    outcome: {
      type: String,
      enum: ["pending", "positive", "negative", "needs_followup"],
      default: "pending",
    },
    outcomeNotes: {
      type: String,
      trim: true,
    },
    followupDate: Date,

    // Removed attachments array

    // System Fields
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
      required: true,
    },
    createdByName: {
      type: String,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    assignedByName: {
      type: String,
    },

    // Timestamps
    completedAt: Date,
    cancelledAt: Date,
    rescheduledAt: Date,
  },
  {
    timestamps: true,
  },
);

// Indexes for better query performance
employeeTaskSchema.index({ candidateId: 1 });
employeeTaskSchema.index({ scheduledDate: 1 });
employeeTaskSchema.index({ status: 1 });
employeeTaskSchema.index({ type: 1 });
employeeTaskSchema.index({ "participants.employeeId": 1 });
employeeTaskSchema.index({ jobPostingId: 1 });

// Pre-save middleware removed since jobId is removed

// Virtual for full datetime
employeeTaskSchema.virtual("scheduledDateTime").get(function () {
  const date = new Date(this.scheduledDate);
  const [hours, minutes] = this.scheduledTime.split(":");
  date.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
  return date;
});

// Virtual for checking if task is overdue
employeeTaskSchema.virtual("isOverdue").get(function () {
  if (this.status === "completed" || this.status === "cancelled") {
    return false;
  }
  const now = new Date();
  const scheduled = this.scheduledDateTime;
  return scheduled < now;
});

// Virtual for checking if task is upcoming
employeeTaskSchema.virtual("isUpcoming").get(function () {
  if (this.status !== "scheduled") {
    return false;
  }
  const now = new Date();
  const scheduled = this.scheduledDateTime;
  const oneDay = 24 * 60 * 60 * 1000;
  return scheduled > now && scheduled < new Date(now.getTime() + oneDay);
});

employeeTaskSchema.virtual("nextStage").get(function () {
  const currentStage = this.interviewStage;
  const isTechnicalRole = this.jobPostingId?.technicalRole || false;

  // CORRECTED WORKFLOW:
  // Screening → Technical/HR → Training → Hired
  if (currentStage === "screening") {
    return isTechnicalRole ? "technical_interview" : "hr_interview";
  } else if (
    currentStage === "technical_interview" ||
    currentStage === "hr_interview"
  ) {
    return "training";
  } else if (currentStage === "training") {
    return "hired";
  } else if (currentStage === "hired") {
    return null;
  } else if (currentStage === "rejected") {
    return null;
  }

  return null;
});

const EmployeeTask = mongoose.model("EmployeeTask", employeeTaskSchema);
module.exports = EmployeeTask;
