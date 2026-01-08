// routes/CMS_Routes/Sales/dashboard.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const Customer = require("../../../models/Customer_Models/Customer");

// Apply auth middleware
router.use(EmployeeAuthMiddleware);

// GET dashboard statistics
router.get("/dashboard", async (req, res) => {
  try {
    // Get current date for calculations
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    // Get total requests
    const totalRequests = await CustomerRequest.countDocuments();

    // Get requests by status
    const pendingRequests = await CustomerRequest.countDocuments({ status: 'pending' });
    const inProgressRequests = await CustomerRequest.countDocuments({ status: 'in_progress' });
    const completedRequests = await CustomerRequest.countDocuments({ status: 'completed' });

    // Get total customers
    const totalCustomers = await Customer.countDocuments();

    // Calculate revenue for this month
    const requestsThisMonth = await CustomerRequest.find({
      status: 'completed',
      updatedAt: { $gte: startOfMonth }
    });

    const revenueThisMonth = requestsThisMonth.reduce((sum, request) => {
      return sum + (request.quotationAmount || request.items.reduce((itemSum, item) => 
        itemSum + (item.totalEstimatedPrice || 0), 0));
    }, 0);

    // Calculate revenue for last month
    const requestsLastMonth = await CustomerRequest.find({
      status: 'completed',
      updatedAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }
    });

    const revenueLastMonth = requestsLastMonth.reduce((sum, request) => {
      return sum + (request.quotationAmount || request.items.reduce((itemSum, item) => 
        itemSum + (item.totalEstimatedPrice || 0), 0));
    }, 0);

    // Calculate revenue growth
    const revenueGrowth = revenueLastMonth > 0 
      ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
      : revenueThisMonth > 0 ? 100 : 0;

    // Calculate average order value
    const completedRequestsCount = await CustomerRequest.countDocuments({ status: 'completed' });
    const averageOrderValue = completedRequestsCount > 0 
      ? revenueThisMonth / completedRequestsCount 
      : 0;

    res.json({
      success: true,
      stats: {
        totalRequests,
        pendingRequests,
        inProgressRequests,
        completedRequests,
        totalCustomers,
        revenueThisMonth,
        revenueGrowth,
        averageOrderValue
      }
    });

  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching dashboard statistics"
    });
  }
});

// GET recent requests
router.get("/dashboard/recent-requests", async (req, res) => {
  try {
    const recentRequests = await CustomerRequest.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('salesPersonAssigned', 'name email')
      .select('-__v -updatedAt');

    res.json({
      success: true,
      requests: recentRequests
    });

  } catch (error) {
    console.error("Error fetching recent requests:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching recent requests"
    });
  }
});

// GET top customers
router.get("/dashboard/top-customers", async (req, res) => {
  try {
    // Aggregate top customers by order value
    const topCustomers = await CustomerRequest.aggregate([
      { $match: { status: 'completed' } },
      { $group: {
          _id: '$customerId',
          totalSpent: { $sum: '$quotationAmount' },
          orderCount: { $sum: 1 }
        }
      },
      { $sort: { totalSpent: -1 } },
      { $limit: 5 },
      { $lookup: {
          from: 'customers',
          localField: '_id',
          foreignField: '_id',
          as: 'customer'
        }
      },
      { $unwind: '$customer' },
      { $project: {
          _id: 1,
          name: '$customer.name',
          email: '$customer.email',
          phone: '$customer.phone',
          totalSpent: 1,
          orderCount: 1
        }
      }
    ]);

    res.json({
      success: true,
      customers: topCustomers
    });

  } catch (error) {
    console.error("Error fetching top customers:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching top customers"
    });
  }
});

module.exports = router;