const mongoose = require("mongoose");

const jobPostingSchema = new mongoose.Schema(
  {
    // Basic Information
    jobTitle: {
      type: String,
      required: [true, "Job title is required"],
      trim: true,
    },
    jobLocation: {
      type: String,
      required: [true, "Job location is required"],
      trim: true,
    },
    lastDate: {
      type: Date,
      required: [true, "Last date is required"],
    },
    jobType: {
      type: String,
      enum: [
        "full_time",
        "part_time",
        "contract",
        "intern",
        "temporary",
        "freelance",
      ],
      required: [true, "Job type is required"],
    },
    jobMode: {
      type: String,
      enum: ["onsite", "hybrid", "remote"],
      required: [true, "Job mode is required"],
    },
    technicalRole: {
      type: Boolean,
      required: [true, "Technical role selection is required"],
      default: false,
    },

    // Hiring Manager Information
    hiringManager: {
      departmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Department",
        required: true,
      },
      departmentName: {
        type: String,
        required: true,
      },
      designation: {
        type: String,
        required: true,
      },
      managerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
      managerName: {
        type: String,
      },
    },

    // Job Details
    description: {
      type: String,
      required: [true, "Description is required"],
    },
    positionsOpen: {
      type: Number,
      required: [true, "Number of positions is required"],
      min: [1, "At least 1 position must be open"],
    },

    // Common Questions for Interview
    commonQuestions: [
      {
        question: {
          type: String,
          required: true,
          trim: true,
        },
        order: {
          type: Number,
          required: true,
        },
      },
    ],

    // Additional Information
    requiredSkills: [String],
    experienceRequired: {
      min: { type: Number, default: 0 },
      max: { type: Number },
    },
    salaryRange: {
      min: { type: Number },
      max: { type: Number },
      // Removed currency since it's always INR
    },

    // Status and Tracking
    status: {
      type: String,
      enum: ["draft", "published", "closed", "archived"],
      default: "published", // Changed default to published since we removed draft
    },
    views: { type: Number, default: 0 },
    applications: { type: Number, default: 0 },

    // System Fields
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
      required: true,
    },
    createdByName: {
      type: String,
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
    },
    publishedAt: Date,
    closedAt: Date,
  },
  {
    timestamps: true,
  },
);

// Indexes for better query performance
jobPostingSchema.index({ status: 1, lastDate: 1 });
jobPostingSchema.index({ "hiringManager.departmentId": 1 });
jobPostingSchema.index({ jobType: 1, jobMode: 1 });
jobPostingSchema.index({ createdAt: -1 });
jobPostingSchema.index({ lastDate: 1 });

// Virtual for checking if job is active
jobPostingSchema.virtual("isActive").get(function () {
  return this.status === "published" && new Date() <= new Date(this.lastDate);
});

// Virtual for days remaining
jobPostingSchema.virtual("daysRemaining").get(function () {
  const today = new Date();
  const lastDate = new Date(this.lastDate);
  const diffTime = lastDate - today;
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
});

// Method to update application count
jobPostingSchema.methods.incrementApplications = function () {
  this.applications += 1;
  return this.save();
};

// Method to increment views
jobPostingSchema.methods.incrementViews = function () {
  this.views += 1;
  return this.save();
};

// Pre-save middleware
jobPostingSchema.pre("save", function (next) {
  // Update status based on dates
  if (this.lastDate && new Date() > new Date(this.lastDate)) {
    this.status = "closed";
    this.closedAt = new Date();
  }

  // Set publishedAt if status changes to published
  if (this.isModified("status") && this.status === "published") {
    this.publishedAt = new Date();
  }

  next();
});

const JobPosting = mongoose.model("JobPosting", jobPostingSchema);
module.exports = JobPosting;
