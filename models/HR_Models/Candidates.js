const mongoose = require("mongoose");

const candidateSchema = new mongoose.Schema(
  {
    // Basic Information
    name: {
      type: String,
      required: [true, "Candidate name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true,
    },

    // Profile Photo
    profilePic: {
      url: String,
      publicId: String,
    },

    // Job Information
    jobPostingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JobPosting",
      required: true,
    },
    jobTitle: {
      type: String,
      required: true,
    },
    appliedDate: {
      type: Date,
      default: Date.now,
    },

    // Experience and Background
    experience: {
      type: String,
      default: "Not specified",
    },
    currentCompany: {
      type: String,
      default: "Not specified",
    },
    noticePeriod: {
      type: String,
      default: "Not specified",
    },
    expectedSalary: {
      type: String,
      default: "Not specified",
    },

    // Documents
    resumeUrl: {
      url: String,
      publicId: String,
    },
    additionalDocuments: [
      {
        title: String,
        url: String,
        publicId: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

    // Recruitment Process
    stage: {
      type: String,
      enum: [
        "screening",
        "technical_interview",
        "hr_interview",
        "training",
        "hired",
        "rejected",
      ],
      default: "screening",
    },

    // Interview Questions & Answers
    interviewQuestions: [
      {
        question: String,
        rating: {
          type: Number,
          min: 1,
          max: 5,
          default: 0,
        },
        notes: String,
        stage: String,
        evaluatedBy: {
          name: String,
          employeeId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
          },
        },
        evaluatedAt: Date,
      },
    ],

    // Calculated rating based on interview questions
    rating: {
      type: Number,
      min: 0,
      max: 5,
      default: 0,
    },

    // Manager Assignment
    managerInCharge: {
      managerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
      managerName: {
        type: String,
      },
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
    },

    // Interview Notes (for backward compatibility)
    interviewNotes: [
      {
        stage: String,
        notes: String,
        rating: Number,
        interviewer: {
          name: String,
          employeeId: String,
        },
        date: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    // Status
    status: {
      type: String,
      enum: ["active", "inactive", "archived"],
      default: "active",
    },

    // System Fields
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes
candidateSchema.index({ jobPostingId: 1, stage: 1 });
candidateSchema.index({ email: 1 });
candidateSchema.index({ status: 1 });
candidateSchema.index({ createdAt: -1 });
candidateSchema.index({ "managerInCharge.managerId": 1 });
candidateSchema.index({ rating: 1 });

// Pre-save middleware to calculate average rating
candidateSchema.pre("save", function (next) {
  this.updatedAt = Date.now();

  // Calculate average rating from interview questions
  if (this.interviewQuestions && this.interviewQuestions.length > 0) {
    const questionsWithRatings = this.interviewQuestions.filter(
      (q) => q.rating > 0,
    );
    if (questionsWithRatings.length > 0) {
      const totalRating = questionsWithRatings.reduce(
        (sum, q) => sum + q.rating,
        0,
      );
      this.rating =
        Math.round((totalRating / questionsWithRatings.length) * 10) / 10;
    }
  }

  // If stage is rejected, set status to archived
  if (this.stage === "rejected") {
    this.status = "archived";
  }

  next();
});

candidateSchema.methods.addInterviewQuestion = function (questionData) {
  if (!this.interviewQuestions) {
    this.interviewQuestions = [];
  }

  // Remove existing question from same stage by same evaluator
  this.interviewQuestions = this.interviewQuestions.filter(
    (q) =>
      !(
        q.stage === questionData.stage &&
        q.evaluatedBy?.employeeId?.toString() ===
          questionData.evaluatedBy?.employeeId?.toString() &&
        q.question === questionData.question
      ),
  );

  this.interviewQuestions.push(questionData);
  return this.save();
};

candidateSchema.methods.calculateOverallRating = function () {
  const questionsWithRatings =
    this.interviewQuestions?.filter((q) => q.rating > 0) || [];

  if (questionsWithRatings.length === 0) {
    this.rating = 0;
    return 0;
  }

  const totalRating = questionsWithRatings.reduce(
    (sum, q) => sum + q.rating,
    0,
  );
  this.rating =
    Math.round((totalRating / questionsWithRatings.length) * 10) / 10;
  return this.rating;
};

candidateSchema.methods.updateStage = function (newStage) {
  this.stage = newStage;

  // If rejected, archive the candidate
  if (newStage === "rejected") {
    this.status = "archived";
  }

  // If hired, mark as active but completed
  if (newStage === "hired") {
    this.status = "active";
  }

  return this.save();
};

const Candidate = mongoose.model("Candidate", candidateSchema);
module.exports = Candidate;
