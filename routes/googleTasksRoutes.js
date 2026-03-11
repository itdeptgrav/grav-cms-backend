const express = require("express");
const router = express.Router();
const { getTasks } = require("../services/googleTasksService");

router.get("/tasks", async (req, res) => {
  try {
    const tasks = await getTasks();

    res.json({
      success: true,
      count: tasks.length,
      data: tasks,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch Google tasks",
      error: error.message,
    });
  }
});

module.exports = router;