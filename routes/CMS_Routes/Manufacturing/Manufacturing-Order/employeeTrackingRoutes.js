// routes/CMS_Routes/Manufacturing/Manufacturing-Order/employeeTrackingRoutes.js - UPDATED WITH FIXES

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const Measurement = require("../../../../models/Customer_Models/Measurement");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

// Parse barcode to get work order and unit info
const parseBarcode = (barcodeId) => {
  try {
    // Format: WO-[ShortID]-[UnitNumber]
    const parts = barcodeId.split("-");
    if (parts.length >= 3 && parts[0] === "WO") {
      return {
        success: true,
        workOrderShortId: parts[1],
        unitNumber: parseInt(parts[2]),
        operationNumber: parts[3] ? parseInt(parts[3]) : null,
      };
    }
    return { success: false, error: "Invalid barcode format" };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Find work order by short ID (last 8 characters of MongoDB ID)
const findWorkOrderByShortId = async (shortId) => {
  try {
    const allWorkOrders = await WorkOrder.find({}).lean();
    return allWorkOrders.find(
      (wo) =>
        wo._id.toString().slice(-8) === shortId ||
        wo.workOrderNumber?.includes(shortId),
    );
  } catch (error) {
    console.error("Error finding work order:", error);
    return null;
  }
};

// SIMPLIFIED FIX: Assume units are completed sequentially starting from 001
const calculateEmployeeSequentialAllocation = (
  productionCompletionData,
  employeeProducts,
  employeeIndex,
) => {
  const overallCompletedQuantity =
    productionCompletionData?.overallCompletedQuantity || 0;
  const product = employeeProducts[0];

  if (!product.workOrderId) {
    return {
      completedUnits: 0,
      pendingUnits: product.quantity,
      unitDetails: [],
    };
  }

  // Calculate employee's unit range
  let employeeStartUnit = 1;
  for (let i = 0; i < employeeIndex; i++) {
    if (employeeProducts[i] && employeeProducts[i].quantity) {
      employeeStartUnit += employeeProducts[i].quantity;
    }
  }
  const employeeEndUnit = employeeStartUnit + product.quantity - 1;

  // FIXED LOGIC: Units are completed sequentially from 001
  // So if overallCompletedQuantity = 9, then units 001-009 are completed

  let completedUnits = 0;

  // How many of this employee's units fall within the first N completed units?
  if (overallCompletedQuantity >= employeeStartUnit) {
    // Some of this employee's units are completed
    completedUnits =
      Math.min(overallCompletedQuantity, employeeEndUnit) -
      employeeStartUnit +
      1;
    // But ensure it's not negative
    completedUnits = Math.max(0, completedUnits);
  } else {
    // None of this employee's units are completed yet
    completedUnits = 0;
  }

  // Create unit details
  const unitDetails = [];
  for (let i = 1; i <= product.quantity; i++) {
    const employeeUnitNumber = employeeStartUnit + i - 1;
    let status = "pending";

    if (employeeUnitNumber <= overallCompletedQuantity) {
      status = "completed";
    } else if (employeeUnitNumber === overallCompletedQuantity + 1) {
      status = "in_progress";
    }

    unitDetails.push({
      unitNumber: employeeUnitNumber,
      employeeUnitIndex: i,
      status: status,
      scans: 0,
    });
  }

  return {
    completedUnits,
    pendingUnits: product.quantity - completedUnits,
    unitDetails,
    employeeUnitRange: {
      start: employeeStartUnit,
      end: employeeEndUnit,
    },
  };
};

// GET employee production tracking for a manufacturing order - USING PRODUCTIONCOMPLETION
router.get("/manufacturing-order/:moId/employees", async (req, res) => {
  try {
    const { moId } = req.params;

    console.log("=== EMPLOYEE TRACKING DEBUG (PRODUCTIONCOMPLETION) ===");
    console.log("MO ID:", moId);

    // Get manufacturing order
    const manufacturingOrder = await CustomerRequest.findById(moId)
      .select("requestType measurementId customerInfo items")
      .lean();

    if (!manufacturingOrder) {
      return res.status(404).json({
        success: false,
        message: "Manufacturing order not found",
      });
    }

    console.log("MO requestType:", manufacturingOrder.requestType);
    console.log("MO measurementId:", manufacturingOrder.measurementId);

    // CRITICAL: Check if it's a measurement conversion
    const isMeasurementConversion = !!(
      manufacturingOrder.requestType === "measurement_conversion" ||
      manufacturingOrder.measurementId
    );

    console.log("Is Measurement Conversion:", isMeasurementConversion);

    if (!isMeasurementConversion) {
      console.log("Not a measurement conversion - returning empty data");
      return res.json({
        success: true,
        employeeData: [],
        workOrders: [],
        stats: {
          totalEmployees: 0,
          totalWorkOrders: 0,
          totalUnitsAssigned: 0,
          totalUnitsCompleted: 0,
          averageCompletion: 0,
        },
      });
    }

    // Get associated work orders WITH PRODUCTION COMPLETION
    const workOrders = await WorkOrder.find({ customerRequestId: moId })
      .select(
        "workOrderNumber stockItemName stockItemId quantity variantAttributes operations status productionCompletion",
      )
      .lean();

    console.log("Work Orders found:", workOrders.length);

    let employeeData = [];

    // Get measurement data
    if (manufacturingOrder.measurementId) {
      const measurement = await Measurement.findById(
        manufacturingOrder.measurementId,
      )
        .select("employeeMeasurements organizationName")
        .lean();

      console.log("Measurement found:", !!measurement);
      console.log(
        "Employee measurements count:",
        measurement?.employeeMeasurements?.length || 0,
      );

      if (measurement && measurement.employeeMeasurements) {
        // Group by employee
        const employeeMap = new Map();

        measurement.employeeMeasurements.forEach((emp, empIndex) => {
          if (!employeeMap.has(emp.employeeId.toString())) {
            employeeMap.set(emp.employeeId.toString(), {
              employeeId: emp.employeeId,
              employeeName: emp.employeeName,
              employeeUIN: emp.employeeUIN,
              gender: emp.gender,
              organizationName: measurement.organizationName,
              originalIndex: empIndex,
              products: [],
              totalQuantity: 0,
              productMap: new Map(),
            });
          }

          const employee = employeeMap.get(emp.employeeId.toString());

          emp.products.forEach((product) => {
            const productKey = `${product.productId}_${product.variantId || "default"}`;

            if (!employee.productMap.has(productKey)) {
              employee.productMap.set(productKey, {
                productId: product.productId,
                productName: product.productName,
                variantId: product.variantId,
                variantName: product.variantName || "Default",
                quantity: 0,
                measurements: product.measurements,
              });
            }

            const productData = employee.productMap.get(productKey);
            productData.quantity += product.quantity;
            employee.totalQuantity += product.quantity;
          });
        });

        // Convert map to array
        employeeData = Array.from(employeeMap.values()).map((emp) => ({
          ...emp,
          products: Array.from(emp.productMap.values()),
          productMap: undefined,
        }));

        console.log("Processed employee data count:", employeeData.length);
      }
    }

    // Group employees by product to calculate sequential allocation
    const productEmployeeMap = new Map();

    employeeData.forEach((employee) => {
      employee.products.forEach((product) => {
        const productKey = `${product.productId}_${product.variantId || "default"}`;

        if (!productEmployeeMap.has(productKey)) {
          productEmployeeMap.set(productKey, []);
        }

        productEmployeeMap.get(productKey).push({
          employeeId: employee.employeeId,
          employeeName: employee.employeeName,
          employeeUIN: employee.employeeUIN,
          originalIndex: employee.originalIndex,
          product: product,
        });
      });
    });

    // Sort employees by original index within each product group
    productEmployeeMap.forEach((employees) => {
      employees.sort((a, b) => a.originalIndex - b.originalIndex);
    });

    // Match work orders to employee products and calculate progress FROM PRODUCTIONCOMPLETION
    const enhancedEmployeeData = await Promise.all(
      employeeData.map(async (employee) => {
        const productsWithProgress = await Promise.all(
          employee.products.map(async (product) => {
            // Find matching work order
            const matchingWorkOrder = workOrders.find(
              (wo) =>
                wo.stockItemName === product.productName ||
                (product.productId &&
                  wo.stockItemId?.toString() === product.productId.toString()),
            );

            if (!matchingWorkOrder) {
              return {
                ...product,
                workOrderId: null,
                workOrderNumber: "Not Found",
                completedUnits: 0,
                pendingUnits: product.quantity,
                completionPercentage: 0,
                unitDetails: Array.from(
                  { length: product.quantity },
                  (_, i) => ({
                    unitNumber: i + 1,
                    status: "pending",
                    scans: 0,
                  }),
                ),
              };
            }

            // Get employee index for this product
            const productKey = `${product.productId}_${product.variantId || "default"}`;
            const productEmployees = productEmployeeMap.get(productKey) || [];
            const employeeIndex = productEmployees.findIndex(
              (emp) =>
                emp.employeeId.toString() === employee.employeeId.toString(),
            );

            // Calculate employee-specific sequential allocation USING PRODUCTIONCOMPLETION
            const progress = calculateEmployeeSequentialAllocation(
              matchingWorkOrder.productionCompletion,
              productEmployees.map((emp) => ({
                ...emp.product,
                workOrderId: matchingWorkOrder._id,
                workOrderNumber: matchingWorkOrder.workOrderNumber,
              })),
              employeeIndex,
            );

            const completionPercentage =
              product.quantity > 0
                ? Math.round((progress.completedUnits / product.quantity) * 100)
                : 0;

            return {
              ...product,
              workOrderId: matchingWorkOrder._id,
              workOrderNumber: matchingWorkOrder.workOrderNumber,
              completedUnits: progress.completedUnits,
              pendingUnits: progress.pendingUnits,
              completionPercentage,
              unitDetails: progress.unitDetails,
              employeeUnitRange: progress.employeeUnitRange,
              lastUpdated: matchingWorkOrder.productionCompletion?.lastSyncedAt,
            };
          }),
        );

        const totalCompleted = productsWithProgress.reduce(
          (sum, p) => sum + (p.completedUnits || 0),
          0,
        );
        const totalAssigned = employee.totalQuantity;
        const overallCompletion =
          totalAssigned > 0
            ? Math.round((totalCompleted / totalAssigned) * 100)
            : 0;

        return {
          ...employee,
          products: productsWithProgress,
          totalCompletedUnits: totalCompleted,
          totalPendingUnits: totalAssigned - totalCompleted,
          overallCompletionPercentage: overallCompletion,
        };
      }),
    );

    // Sort employees by completion percentage
    enhancedEmployeeData.sort(
      (a, b) => b.overallCompletionPercentage - a.overallCompletionPercentage,
    );

    // Calculate statistics FROM PRODUCTIONCOMPLETION
    const totalUnitsAssigned = enhancedEmployeeData.reduce(
      (sum, emp) => sum + emp.totalQuantity,
      0,
    );
    const totalUnitsCompleted = enhancedEmployeeData.reduce(
      (sum, emp) => sum + emp.totalCompletedUnits,
      0,
    );
    const averageCompletion =
      enhancedEmployeeData.length > 0
        ? Math.round(
            enhancedEmployeeData.reduce(
              (sum, emp) => sum + emp.overallCompletionPercentage,
              0,
            ) / enhancedEmployeeData.length,
          )
        : 0;

    // Also calculate from workOrders productionCompletion for verification
    const totalFromProductionCompletion = workOrders.reduce(
      (sum, wo) =>
        sum + (wo.productionCompletion?.overallCompletedQuantity || 0),
      0,
    );

    console.log("=== FINAL STATS (FROM PRODUCTIONCOMPLETION) ===");
    console.log("Total Employees:", enhancedEmployeeData.length);
    console.log("Total Units Assigned:", totalUnitsAssigned);
    console.log("Total Units Completed (employee sum):", totalUnitsCompleted);
    console.log(
      "Total Units Completed (productionCompletion):",
      totalFromProductionCompletion,
    );
    console.log("Average Completion:", averageCompletion);
    console.log("==================");

    res.json({
      success: true,
      employeeData: enhancedEmployeeData,
      workOrders: workOrders.map((wo) => ({
        _id: wo._id,
        workOrderNumber: wo.workOrderNumber,
        stockItemName: wo.stockItemName,
        stockItemId: wo.stockItemId,
        quantity: wo.quantity,
        status: wo.status,
        productionCompletion: {
          overallCompletedQuantity:
            wo.productionCompletion?.overallCompletedQuantity || 0,
          overallCompletionPercentage:
            wo.productionCompletion?.overallCompletionPercentage || 0,
          operationCompletion:
            wo.productionCompletion?.operationCompletion || [],
          lastSyncedAt: wo.productionCompletion?.lastSyncedAt,
        },
      })),
      stats: {
        totalEmployees: enhancedEmployeeData.length,
        totalWorkOrders: workOrders.length,
        totalUnitsAssigned,
        totalUnitsCompleted,
        totalUnitsFromProductionCompletion: totalFromProductionCompletion,
        averageCompletion,
      },
    });
  } catch (error) {
    console.error("Error fetching employee tracking:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching employee tracking data",
      error: error.message,
    });
  }
});

// GET search employees by name or UIN
router.get("/search", async (req, res) => {
  try {
    const { query, manufacturingOrderId } = req.query;

    if (!query || query.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Search query must be at least 2 characters",
      });
    }

    // If manufacturing order ID is provided, search within that order
    if (manufacturingOrderId) {
      const manufacturingOrder = await CustomerRequest.findById(
        manufacturingOrderId,
      )
        .select("measurementId")
        .lean();

      if (manufacturingOrder?.measurementId) {
        const measurement = await Measurement.findById(
          manufacturingOrder.measurementId,
        )
          .select("employeeMeasurements organizationName")
          .lean();

        if (measurement?.employeeMeasurements) {
          const searchResults = measurement.employeeMeasurements
            .filter(
              (emp) =>
                emp.employeeName.toLowerCase().includes(query.toLowerCase()) ||
                emp.employeeUIN.toLowerCase().includes(query.toLowerCase()),
            )
            .map((emp) => ({
              employeeId: emp.employeeId,
              employeeName: emp.employeeName,
              employeeUIN: emp.employeeUIN,
              gender: emp.gender,
              organizationName: measurement.organizationName,
            }));

          return res.json({
            success: true,
            results: searchResults,
            count: searchResults.length,
          });
        }
      }
    }

    // General search across all measurements
    const measurements = await Measurement.find({
      $or: [
        {
          "employeeMeasurements.employeeName": { $regex: query, $options: "i" },
        },
        {
          "employeeMeasurements.employeeUIN": { $regex: query, $options: "i" },
        },
      ],
    })
      .select("employeeMeasurements organizationName")
      .limit(10)
      .lean();

    const results = [];
    measurements.forEach((measurement) => {
      measurement.employeeMeasurements.forEach((emp) => {
        if (
          emp.employeeName.toLowerCase().includes(query.toLowerCase()) ||
          emp.employeeUIN.toLowerCase().includes(query.toLowerCase())
        ) {
          results.push({
            employeeId: emp.employeeId,
            employeeName: emp.employeeName,
            employeeUIN: emp.employeeUIN,
            gender: emp.gender,
            organizationName: measurement.organizationName,
          });
        }
      });
    });

    // Remove duplicates
    const uniqueResults = Array.from(
      new Map(
        results.map((item) => [item.employeeId.toString(), item]),
      ).values(),
    );

    res.json({
      success: true,
      results: uniqueResults,
      count: uniqueResults.length,
    });
  } catch (error) {
    console.error("Error searching employees:", error);
    res.status(500).json({
      success: false,
      message: "Server error while searching employees",
      error: error.message,
    });
  }
});

// GET detailed employee progress
router.get(
  "/employee/:employeeId/progress/:manufacturingOrderId",
  async (req, res) => {
    try {
      const { employeeId, manufacturingOrderId } = req.params;

      const manufacturingOrder = await CustomerRequest.findById(
        manufacturingOrderId,
      )
        .select("measurementId requestId")
        .lean();

      if (!manufacturingOrder) {
        return res.status(404).json({
          success: false,
          message: "Manufacturing order not found",
        });
      }

      // Get the measurement and find the specific employee
      const measurement = await Measurement.findById(
        manufacturingOrder.measurementId,
      )
        .select("employeeMeasurements organizationName")
        .lean();

      if (!measurement) {
        return res.status(404).json({
          success: false,
          message: "Measurement not found for this manufacturing order",
        });
      }

      // Find the employee in the measurements
      const employeeIndex = measurement.employeeMeasurements.findIndex(
        (emp) => emp.employeeId.toString() === employeeId,
      );

      if (employeeIndex === -1) {
        return res.status(404).json({
          success: false,
          message: "Employee not found in this manufacturing order",
        });
      }

      const employeeData = measurement.employeeMeasurements[employeeIndex];

      // Get associated work orders
      const workOrders = await WorkOrder.find({
        customerRequestId: manufacturingOrderId,
      })
        .select("workOrderNumber stockItemName stockItemId quantity operations")
        .lean();

      // Get production tracking (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);

      const productionTracking = await ProductionTracking.find({
        date: { $gte: thirtyDaysAgo },
      })
        .select("machines")
        .lean();

      // Collect all barcode scans
      const allBarcodeScans = [];
      if (productionTracking) {
        productionTracking.forEach((trackDoc) => {
          trackDoc.machines?.forEach((machine) => {
            machine.operationTracking?.forEach((op) => {
              op.operators?.forEach((operator) => {
                operator.barcodeScans?.forEach((scan) => {
                  allBarcodeScans.push({
                    _id: scan._id,
                    barcodeId: scan.barcodeId,
                    timestamp: scan.timeStamp,
                  });
                });
              });
            });
          });
        });
      }

      // Group all employees with same products for sequential calculation
      const productEmployeeMap = new Map();

      measurement.employeeMeasurements.forEach((emp, empIdx) => {
        emp.products.forEach((product) => {
          const productKey = `${product.productId}_${product.variantId || "default"}`;

          if (!productEmployeeMap.has(productKey)) {
            productEmployeeMap.set(productKey, []);
          }

          productEmployeeMap.get(productKey).push({
            employeeIndex: empIdx,
            employeeId: emp.employeeId,
            product: product,
          });
        });
      });

      // Sort by employee index within each product group
      productEmployeeMap.forEach((employees) => {
        employees.sort((a, b) => a.employeeIndex - b.employeeIndex);
      });

      // Analyze each product for this employee
      const productProgress = await Promise.all(
        employeeData.products.map(async (product) => {
          const matchingWorkOrder = workOrders.find(
            (wo) =>
              wo.stockItemName === product.productName ||
              (product.productId &&
                wo.stockItemId?.toString() === product.productId.toString()),
          );

          if (!matchingWorkOrder) {
            return {
              productName: product.productName,
              variantName: product.variantName || "Default",
              quantity: product.quantity,
              workOrderNumber: "Not Found",
              completedUnits: 0,
              unitDetails: Array.from({ length: product.quantity }, (_, i) => ({
                unitNumber: i + 1,
                status: "pending",
                scans: 0,
              })),
            };
          }

          // Get employee's position for this product
          const productKey = `${product.productId}_${product.variantId || "default"}`;
          const productEmployees = productEmployeeMap.get(productKey) || [];
          const currentEmployeeIndex = productEmployees.findIndex(
            (emp) => emp.employeeId.toString() === employeeId,
          );

          // Prepare data for sequential calculation
          const allProductEmployees = productEmployees.map((emp) => ({
            ...emp.product,
            workOrderId: matchingWorkOrder._id,
          }));

          // Calculate employee-specific sequential allocation
          const progress = calculateEmployeeSequentialAllocation(
            allBarcodeScans,
            allProductEmployees,
            currentEmployeeIndex,
          );

          const completionPercentage =
            product.quantity > 0
              ? Math.round((progress.completedUnits / product.quantity) * 100)
              : 0;

          return {
            productName: product.productName,
            variantName: product.variantName || "Default",
            quantity: product.quantity,
            workOrderNumber: matchingWorkOrder.workOrderNumber,
            workOrderId: matchingWorkOrder._id,
            completedUnits: progress.completedUnits,
            pendingUnits: progress.pendingUnits,
            completionPercentage,
            unitDetails: progress.unitDetails,
            employeeUnitRange: progress.employeeUnitRange,
          };
        }),
      );

      const totalCompleted = productProgress.reduce(
        (sum, p) => sum + p.completedUnits,
        0,
      );
      const totalAssigned = employeeData.products.reduce(
        (sum, p) => sum + p.quantity,
        0,
      );

      res.json({
        success: true,
        employee: {
          employeeId: employeeData.employeeId,
          employeeName: employeeData.employeeName,
          employeeUIN: employeeData.employeeUIN,
          gender: employeeData.gender,
          originalIndex: employeeIndex,
          organizationName: measurement.organizationName,
        },
        manufacturingOrder: {
          _id: manufacturingOrder._id,
          requestId: manufacturingOrder.requestId,
        },
        productProgress,
        summary: {
          totalAssignedUnits: totalAssigned,
          totalCompletedUnits: totalCompleted,
          totalPendingUnits: totalAssigned - totalCompleted,
          overallCompletionPercentage:
            totalAssigned > 0
              ? Math.round((totalCompleted / totalAssigned) * 100)
              : 0,
        },
      });
    } catch (error) {
      console.error("Error fetching employee progress:", error);
      res.status(500).json({
        success: false,
        message: "Server error while fetching employee progress",
        error: error.message,
      });
    }
  },
);

module.exports = router;
