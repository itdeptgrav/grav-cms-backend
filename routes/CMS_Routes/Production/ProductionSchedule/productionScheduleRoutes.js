const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const ProductionSchedule = require("../../../../models/CMS_Models/Manufacturing/Production/ProductionSchedule/ProductionSchedule");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");

router.use(EmployeeAuthMiddleware);

// FIXED: Helper to normalize date (UTC without timezone shift)
const normalizeDate = (dateString) => {
    const date = new Date(dateString);
    // Create UTC date at midnight
    const utcDate = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        0, 0, 0, 0
    ));
    return utcDate;
};

// FIXED: Helper to format time (local time)
const formatTime = (date) => {
    if (!date) return "00:00";
    const d = new Date(date);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
};

// FIXED: Parse time on specific date (UTC)
const parseTimeOnDate = (timeStr, baseDate) => {
    const [hours, minutes] = timeStr.split(":").map(Number);
    const date = new Date(baseDate);
    // Set local time then convert to UTC
    date.setHours(hours, minutes, 0, 0);
    return date;
};

// FIXED: Calculate minutes between times
const calculateMinutesBetween = (start, end) => {
    return Math.floor((end - start) / (1000 * 60));
};

// routes/CMS_Routes/Manufacturing/ProductionSchedule/productionScheduleRoutes.js
// Replace the scheduleSingleWorkOrder function completely:

const scheduleSingleWorkOrder = async (workOrder, startDate, manufacturingOrderId, colorCode, userId, startFromTime = null, isReschedule = false) => {
    const totalMinutes = workOrder.durationMinutes;
    let remainingMinutes = totalMinutes;

    const scheduledSegments = [];
    let currentDate = normalizeDate(startDate);
    let currentTime = startFromTime ? new Date(startFromTime) : null;

    console.log(`Scheduling WO ${workOrder.workOrderNumber}, total minutes: ${totalMinutes}, start date: ${currentDate.toISOString()}, isReschedule: ${isReschedule}`);

    // If rescheduling, first remove existing schedule for this work order
    if (isReschedule) {
        await ProductionSchedule.updateMany(
            { "scheduledWorkOrders.workOrderId": workOrder._id },
            { $pull: { scheduledWorkOrders: { workOrderId: workOrder._id } } }
        );
    }

    while (remainingMinutes > 0) {
        // Get or create schedule for current date
        let schedule = await ProductionSchedule.findOne({ date: currentDate });
        if (!schedule) {
            const isSunday = currentDate.getUTCDay() === 0;
            schedule = new ProductionSchedule({
                date: currentDate,
                createdBy: userId,
                workHours: {
                    startTime: "09:30",
                    endTime: "18:30",
                    totalMinutes: 540,
                    isActive: !isSunday,
                    customHours: false
                }
            });
        }

        // Check if day is active (considering Sunday override)
        const dayOfWeek = currentDate.getUTCDay();
        const isSunday = dayOfWeek === 0;
        const isActiveDay = schedule.workHours.isActive ||
            (isSunday && schedule.isSundayOverride);

        if (!isActiveDay) {
            console.log(`Skipping inactive day: ${currentDate.toISOString()}, isSunday: ${isSunday}, isSundayOverride: ${schedule.isSundayOverride}`);
            currentDate = new Date(currentDate);
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            currentTime = null;
            continue;
        }

        // Calculate work hours for this day
        const workStart = parseTimeOnDate(schedule.workHours.startTime, currentDate);
        const workEnd = parseTimeOnDate(schedule.workHours.endTime, currentDate);

        // Determine start time for this segment
        let segmentStart;
        if (currentTime) {
            segmentStart = new Date(currentTime);
        } else {
            // Check if there are existing work orders on this day
            const existingWorkOrders = schedule.scheduledWorkOrders.filter(
                wo => !isReschedule || wo.workOrderId.toString() !== workOrder._id.toString()
            );

            if (existingWorkOrders.length > 0) {
                // Start after last work order
                const lastWO = existingWorkOrders[existingWorkOrders.length - 1];
                segmentStart = new Date(lastWO.scheduledEndTime);
            } else {
                // Start at work start time
                segmentStart = new Date(workStart);
            }
        }

        // Skip breaks
        const allBreaks = [...(schedule.defaultBreaks || []), ...(schedule.breaks || [])];
        for (const br of allBreaks) {
            const breakStart = parseTimeOnDate(br.startTime, currentDate);
            const breakEnd = parseTimeOnDate(br.endTime, currentDate);

            if (segmentStart >= breakStart && segmentStart < breakEnd) {
                segmentStart = new Date(breakEnd);
            }
        }

        // Calculate maximum available minutes for today
        const maxEndTime = new Date(workEnd);
        let maxMinutesToday = calculateMinutesBetween(segmentStart, maxEndTime);

        // Adjust for breaks that occur during this time slot
        for (const br of allBreaks) {
            const breakStart = parseTimeOnDate(br.startTime, currentDate);
            const breakEnd = parseTimeOnDate(br.endTime, currentDate);

            if (segmentStart < breakEnd && maxEndTime > breakStart) {
                // The work period overlaps with a break
                if (segmentStart < breakStart) {
                    // Work starts before break
                    const minutesBeforeBreak = calculateMinutesBetween(segmentStart, breakStart);
                    if (minutesBeforeBreak > 0) {
                        maxMinutesToday = minutesBeforeBreak;
                        break; // Can only work before the break
                    }
                }
                // If work starts after break or at break end, continue to next break check
            }
        }

        let minutesToSchedule = Math.min(remainingMinutes, maxMinutesToday);

        if (minutesToSchedule <= 0) {
            // Move to next day
            currentDate = new Date(currentDate);
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            currentTime = null;
            continue;
        }

        let segmentEnd = new Date(segmentStart);
        segmentEnd.setMinutes(segmentEnd.getMinutes() + minutesToSchedule);

        // Check if segment overlaps with any break and adjust
        let adjustedEndTime = new Date(segmentEnd);
        for (const br of allBreaks) {
            const breakStart = parseTimeOnDate(br.startTime, currentDate);
            const breakEnd = parseTimeOnDate(br.endTime, currentDate);

            if (segmentStart < breakEnd && adjustedEndTime > breakStart) {
                // Work segment overlaps with break, extend end time by break duration
                const breakDuration = calculateMinutesBetween(breakStart, breakEnd);
                adjustedEndTime.setMinutes(adjustedEndTime.getMinutes() + breakDuration);
            }
        }

        // Final duration
        const segmentDuration = calculateMinutesBetween(segmentStart, adjustedEndTime);

        // Check if this work order already exists on this day (for reschedule)
        const existingIndex = schedule.scheduledWorkOrders.findIndex(
            wo => wo.workOrderId.toString() === workOrder._id.toString()
        );

        if (existingIndex >= 0) {
            // Update existing entry
            schedule.scheduledWorkOrders[existingIndex] = {
                ...schedule.scheduledWorkOrders[existingIndex],
                scheduledStartTime: segmentStart,
                scheduledEndTime: adjustedEndTime,
                durationMinutes: segmentDuration
            };
        } else {
            // Add new entry
            schedule.scheduledWorkOrders.push({
                workOrderId: workOrder._id,
                workOrderNumber: workOrder.workOrderNumber,
                manufacturingOrderId,
                manufacturingOrderNumber: `MO-${workOrder.customerRequestId?.requestId || manufacturingOrderId}`,
                stockItemName: workOrder.stockItemId?.name || "Unknown",
                quantity: workOrder.quantity,
                scheduledStartTime: segmentStart,
                scheduledEndTime: adjustedEndTime,
                durationMinutes: segmentDuration,
                colorCode: colorCode,
                priority: workOrder.priority,
                notes: `Part of ${totalMinutes} minute work order`,
                assignedTo: userId
            });
        }

        await schedule.save();

        scheduledSegments.push({
            date: new Date(currentDate),
            startTime: new Date(segmentStart),
            endTime: new Date(adjustedEndTime),
            minutes: segmentDuration
        });

        remainingMinutes -= minutesToSchedule;

        if (remainingMinutes > 0) {
            // Continue to next day
            currentDate = new Date(currentDate);
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            currentTime = null;
        }
    }

    return scheduledSegments;
};

// GET schedules
router.get("/", async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        let query = {};

        if (startDate && endDate) {
            const start = normalizeDate(startDate);
            const end = normalizeDate(endDate);
            end.setUTCHours(23, 59, 59, 999);

            query.date = { $gte: start, $lte: end };
        } else {
            const today = new Date();
            const startOfWeek = normalizeDate(today);
            startOfWeek.setUTCDate(today.getUTCDate() - today.getUTCDay());

            const endOfWeek = normalizeDate(startOfWeek);
            endOfWeek.setUTCDate(startOfWeek.getUTCDate() + 6);
            endOfWeek.setUTCHours(23, 59, 59, 999);

            query.date = { $gte: startOfWeek, $lte: endOfWeek };
        }

        const schedules = await ProductionSchedule.find(query)
            .populate("scheduledWorkOrders.workOrderId", "workOrderNumber stockItemName quantity status durationMinutes")
            .populate("scheduledWorkOrders.manufacturingOrderId", "requestId customerInfo.name")
            .sort({ date: 1 });

        res.json({
            success: true,
            schedules
        });

    } catch (error) {
        console.error("Error fetching production schedule:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching production schedule"
        });
    }
});

// GET manufacturing orders
router.get("/manufacturing-orders", async (req, res) => {
    try {
        const manufacturingOrders = await CustomerRequest.find({
            status: "quotation_sales_approved"
        })
            .populate({
                path: "customerId",
                select: "name"
            })
            .lean();

        const allSchedules = await ProductionSchedule.find({})
            .select("scheduledWorkOrders.workOrderId")
            .lean();

        const scheduledWorkOrderIds = new Set();
        allSchedules.forEach(schedule => {
            schedule.scheduledWorkOrders?.forEach(wo => {
                if (wo.workOrderId) {
                    scheduledWorkOrderIds.add(wo.workOrderId.toString());
                }
            });
        });

        const manufacturingOrdersWithWorkOrders = await Promise.all(
            manufacturingOrders.map(async (mo) => {
                const workOrders = await WorkOrder.find({
                    customerRequestId: mo._id,
                    status: { $in: ["planned", "scheduled"] }
                })
                    .populate("stockItemId", "name reference")
                    .lean();

                const unscheduledWorkOrders = workOrders.filter(wo =>
                    !scheduledWorkOrderIds.has(wo._id.toString())
                );

                const workOrdersWithTime = unscheduledWorkOrders.map(wo => {
                    let totalSecondsForOnePiece = 0;
                    if (wo.operations && Array.isArray(wo.operations)) {
                        totalSecondsForOnePiece = wo.operations.reduce(
                            (total, op) => total + (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0), 0
                        );
                    }

                    const totalSeconds = totalSecondsForOnePiece * wo.quantity;
                    const durationMinutes = Math.ceil(totalSeconds / 60);

                    return {
                        ...wo,
                        durationMinutes,
                        formattedDuration: formatDuration(totalSeconds)
                    };
                });

                const colorCode = generateColorCode(mo._id.toString());

                return {
                    ...mo,
                    moNumber: `MO-${mo.requestId}`,
                    workOrders: workOrdersWithTime,
                    colorCode,
                    totalWorkOrders: workOrdersWithTime.length,
                    totalDurationMinutes: workOrdersWithTime.reduce((sum, wo) => sum + (wo.durationMinutes || 0), 0)
                };
            })
        );

        res.json({
            success: true,
            manufacturingOrders: manufacturingOrdersWithWorkOrders
        });

    } catch (error) {
        console.error("Error fetching manufacturing orders:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching manufacturing orders"
        });
    }
});

// FIXED: Schedule work order endpoint
router.post("/schedule-work-order-from-date", async (req, res) => {
    try {
        const { workOrderId, manufacturingOrderId, startDate, colorCode } = req.body;

        console.log("API Call - Schedule WO:", { workOrderId, startDate });

        // FIXED: Use UTC date to avoid timezone issues
        const startDateObj = normalizeDate(startDate);
        console.log("Normalized start date (UTC):", startDateObj.toISOString());

        const workOrder = await WorkOrder.findById(workOrderId)
            .populate("stockItemId", "name")
            .populate("customerRequestId", "requestId");

        if (!workOrder) {
            return res.status(404).json({
                success: false,
                message: "Work order not found"
            });
        }

        // Check if already scheduled
        const existingSchedule = await ProductionSchedule.findOne({
            "scheduledWorkOrders.workOrderId": workOrderId
        });

        if (existingSchedule) {
            return res.status(400).json({
                success: false,
                message: "Work order is already scheduled"
            });
        }

        // Calculate duration
        let totalSecondsForOnePiece = 0;
        if (workOrder.operations && Array.isArray(workOrder.operations)) {
            totalSecondsForOnePiece = workOrder.operations.reduce(
                (total, op) => total + (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0), 0
            );
        }

        const totalSeconds = totalSecondsForOnePiece * workOrder.quantity;
        const totalMinutes = Math.ceil(totalSeconds / 60);

        workOrder.durationMinutes = totalMinutes;
        await workOrder.save();

        // Schedule the work order
        const scheduledSegments = await scheduleSingleWorkOrder(
            workOrder,
            startDateObj,
            manufacturingOrderId,
            colorCode,
            req.user.id
        );

        if (scheduledSegments.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Could not schedule work order"
            });
        }

        // Update work order
        workOrder.status = "scheduled";
        workOrder.timeline.scheduledStartDate = scheduledSegments[0].startTime;
        workOrder.timeline.scheduledEndDate = scheduledSegments[scheduledSegments.length - 1].endTime;
        await workOrder.save();

        res.json({
            success: true,
            message: `Work order scheduled across ${scheduledSegments.length} day(s)`,
            totalMinutes,
            daysNeeded: scheduledSegments.length,
            scheduledSegments,
            startDate: startDateObj.toISOString().split('T')[0]
        });

    } catch (error) {
        console.error("Error scheduling work order:", error);
        res.status(500).json({
            success: false,
            message: "Server error while scheduling work order"
        });
    }
});

// FIXED: Schedule manufacturing order sequentially
router.post("/schedule-manufacturing-order-sequential", async (req, res) => {
    try {
        const { manufacturingOrderId, startDate, colorCode } = req.body;

        console.log("API Call - Sequential MO:", { manufacturingOrderId, startDate });

        // FIXED: Use UTC date
        let currentDate = normalizeDate(startDate);
        console.log("Normalized start date for MO (UTC):", currentDate.toISOString());

        const workOrders = await WorkOrder.find({
            customerRequestId: manufacturingOrderId,
            status: "planned"
        })
            .populate("stockItemId", "name")
            .populate("customerRequestId", "requestId")
            .sort({ createdAt: 1 });

        if (workOrders.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No work orders available for scheduling"
            });
        }

        const scheduledWorkOrders = [];
        let lastEndTime = null;

        for (const workOrder of workOrders) {
            console.log(`Scheduling WO ${workOrder.workOrderNumber} starting from ${currentDate.toISOString()}`);

            // Calculate duration
            let totalSecondsForOnePiece = 0;
            if (workOrder.operations && Array.isArray(workOrder.operations)) {
                totalSecondsForOnePiece = workOrder.operations.reduce(
                    (total, op) => total + (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0), 0
                );
            }

            const totalSeconds = totalSecondsForOnePiece * workOrder.quantity;
            const totalMinutes = Math.ceil(totalSeconds / 60);

            workOrder.durationMinutes = totalMinutes;

            // Schedule this work order
            let startFromTime = null;
            if (lastEndTime) {
                // Check if lastEndTime is on same day as currentDate
                const lastEndDate = normalizeDate(lastEndTime);
                if (lastEndDate.getTime() === currentDate.getTime()) {
                    startFromTime = lastEndTime;
                }
            }

            const scheduledSegments = await scheduleSingleWorkOrder(
                workOrder,
                currentDate,
                manufacturingOrderId,
                colorCode,
                req.user.id,
                startFromTime
            );

            if (scheduledSegments.length === 0) {
                console.log(`Could not schedule ${workOrder.workOrderNumber}`);
                continue;
            }

            // Update work order
            workOrder.status = "scheduled";
            workOrder.timeline.scheduledStartDate = scheduledSegments[0].startTime;
            workOrder.timeline.scheduledEndDate = scheduledSegments[scheduledSegments.length - 1].endTime;
            await workOrder.save();

            scheduledWorkOrders.push({
                workOrderId: workOrder._id,
                workOrderNumber: workOrder.workOrderNumber,
                totalMinutes,
                daysNeeded: scheduledSegments.length,
                scheduledSegments
            });

            // Update for next work order
            const lastSegment = scheduledSegments[scheduledSegments.length - 1];
            lastEndTime = lastSegment.endTime;

            // Set next start date
            currentDate = normalizeDate(lastSegment.date);

            // Check if we should continue on same day
            const schedule = await ProductionSchedule.findOne({ date: currentDate });
            if (schedule && (schedule.workHours.isActive || (currentDate.getUTCDay() === 0 && schedule.isSundayOverride))) {
                const workEnd = parseTimeOnDate(schedule.workHours.endTime, currentDate);
                if (lastEndTime < workEnd) {
                    // Continue on same day
                    console.log(`Continuing on same day: ${currentDate.toISOString()}`);
                } else {
                    // Move to next day
                    currentDate = new Date(currentDate);
                    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
                    lastEndTime = null;
                    console.log(`Moving to next day: ${currentDate.toISOString()}`);
                }
            } else {
                // Move to next active day
                currentDate = new Date(currentDate);
                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
                lastEndTime = null;
            }
        }

        res.json({
            success: true,
            message: `Scheduled ${scheduledWorkOrders.length} work orders`,
            scheduledWorkOrders
        });

    } catch (error) {
        console.error("Error scheduling manufacturing order:", error);
        res.status(500).json({
            success: false,
            message: "Server error while scheduling manufacturing order"
        });
    }
});

// routes/CMS_Routes/Manufacturing/ProductionSchedule/productionScheduleRoutes.js
// Update the day settings PUT endpoint:

router.put("/day-settings/:date", async (req, res) => {
    try {
        const { date } = req.params;
        const { workHours, breaks, isHoliday, isSundayOverride, holidayReason } = req.body;

        const dateObj = normalizeDate(date);
        const isSunday = dateObj.getUTCDay() === 0;

        console.log("Updating day settings for:", dateObj.toISOString(), "isSunday:", isSunday);

        let schedule = await ProductionSchedule.findOne({ date: dateObj });

        const wasActive = schedule?.workHours?.isActive || false;
        const oldStartTime = schedule?.workHours?.startTime || "09:30";
        const oldEndTime = schedule?.workHours?.endTime || "18:30";

        if (!schedule) {
            schedule = new ProductionSchedule({
                date: dateObj,
                createdBy: req.user.id,
                workHours: {
                    startTime: "09:30",
                    endTime: "18:30",
                    totalMinutes: 540,
                    isActive: !isSunday,
                    customHours: false
                }
            });
        }

        // Store old work hours for comparison
        const oldWorkHours = {
            startTime: schedule.workHours.startTime,
            endTime: schedule.workHours.endTime,
            totalMinutes: schedule.workHours.totalMinutes,
            isActive: schedule.workHours.isActive
        };

        // Update settings
        if (workHours) {
            schedule.workHours = {
                ...schedule.workHours,
                ...workHours,
                customHours: true
            };
        }

        if (breaks !== undefined) {
            schedule.breaks = breaks;
        }

        // Handle Sunday override properly
        if (isSunday) {
            if (isSundayOverride !== undefined) {
                schedule.isSundayOverride = isSundayOverride;
                schedule.workHours.isActive = isSundayOverride;
                schedule.isHoliday = !isSundayOverride;

                if (isSundayOverride && !holidayReason) {
                    schedule.holidayReason = "";
                } else if (!isSundayOverride && !holidayReason) {
                    schedule.holidayReason = "Sunday - Day Off";
                }
            }
        } else {
            // For non-Sunday days
            if (isHoliday !== undefined) {
                schedule.isHoliday = isHoliday;
                schedule.workHours.isActive = !isHoliday;
            }
        }

        if (holidayReason !== undefined) {
            schedule.holidayReason = holidayReason;
        }

        schedule.updatedBy = req.user.id;
        await schedule.save();

        const isNowActive = schedule.workHours.isActive;
        const workHoursChanged = (oldStartTime !== schedule.workHours.startTime) ||
            (oldEndTime !== schedule.workHours.endTime);

        // Only reschedule if:
        // 1. Day changed from inactive to active (Sunday override enabled)
        // 2. Work hours changed (start/end time modified)
        // 3. Day changed from active to inactive
        let rescheduled = false;
        if (wasActive !== isNowActive || workHoursChanged) {
            console.log(`Rescheduling needed: wasActive=${wasActive}, isNowActive=${isNowActive}, workHoursChanged=${workHoursChanged}`);

            // If day became active (e.g., Sunday override enabled), reschedule from that day
            // If day became inactive, reschedule from next day
            // If work hours changed, reschedule from that day
            const rescheduleStartDate = !isNowActive ?
                new Date(dateObj.getTime() + 24 * 60 * 60 * 1000) : // Next day if became inactive
                dateObj; // Same day if became active or work hours changed

            await rescheduleFromDate(rescheduleStartDate, req.user.id);
            rescheduled = true;
        }

        res.json({
            success: true,
            message: "Day settings updated successfully",
            rescheduled: rescheduled,
            schedule
        });

    } catch (error) {
        console.error("Error updating day settings:", error);
        res.status(500).json({
            success: false,
            message: "Server error while updating day settings"
        });
    }
});

// routes/CMS_Routes/Manufacturing/ProductionSchedule/productionScheduleRoutes.js
// Replace the rescheduleFromDate function completely:

const rescheduleFromDate = async (fromDate, userId) => {
    try {
        console.log("RESCHEDULING from date:", fromDate.toISOString());

        // Find all schedules from this date onward
        const schedules = await ProductionSchedule.find({
            date: { $gte: fromDate }
        }).sort({ date: 1 });

        // Collect all unique work orders that need rescheduling
        const workOrdersToReschedule = new Map();

        for (const schedule of schedules) {
            for (const wo of schedule.scheduledWorkOrders) {
                const woId = wo.workOrderId.toString();
                if (!workOrdersToReschedule.has(woId)) {
                    workOrdersToReschedule.set(woId, {
                        workOrderId: wo.workOrderId,
                        manufacturingOrderId: wo.manufacturingOrderId,
                        colorCode: wo.colorCode,
                        earliestDate: schedule.date
                    });
                }
            }
        }

        console.log(`Found ${workOrdersToReschedule.size} work orders to reschedule`);

        // Process work orders in groups by manufacturing order to maintain sequence
        const workOrdersByMO = new Map();

        for (const [woId, woData] of workOrdersToReschedule) {
            const moId = woData.manufacturingOrderId.toString();
            if (!workOrdersByMO.has(moId)) {
                workOrdersByMO.set(moId, []);
            }
            workOrdersByMO.get(moId).push(woId);
        }

        // Reschedule each manufacturing order's work orders
        for (const [moId, woIds] of workOrdersByMO) {
            console.log(`Processing MO ${moId} with ${woIds.length} work orders`);

            // Get work orders in their original sequence
            const workOrders = await WorkOrder.find({
                _id: { $in: woIds }
            })
                .populate("stockItemId", "name")
                .populate("customerRequestId", "requestId")
                .sort({ createdAt: 1 });

            if (workOrders.length === 0) continue;

            // Find the earliest date for this MO's work orders
            let earliestDate = new Date('9999-12-31');
            for (const woId of woIds) {
                const woData = workOrdersToReschedule.get(woId);
                if (woData.earliestDate < earliestDate) {
                    earliestDate = woData.earliestDate;
                }
            }

            let currentDate = normalizeDate(earliestDate);
            let lastEndTime = null;

            for (const workOrder of workOrders) {
                console.log(`Rescheduling WO ${workOrder.workOrderNumber} from ${currentDate.toISOString()}`);

                // Get color code
                const woData = workOrdersToReschedule.get(workOrder._id.toString());
                const colorCode = woData?.colorCode || "#3B82F6";

                // Calculate duration
                let totalSecondsForOnePiece = 0;
                if (workOrder.operations && Array.isArray(workOrder.operations)) {
                    totalSecondsForOnePiece = workOrder.operations.reduce(
                        (total, op) => total + (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0), 0
                    );
                }

                const totalSeconds = totalSecondsForOnePiece * workOrder.quantity;
                const totalMinutes = Math.ceil(totalSeconds / 60);
                workOrder.durationMinutes = totalMinutes;

                // Determine start time
                let startFromTime = null;
                if (lastEndTime) {
                    const lastEndDate = normalizeDate(lastEndTime);
                    if (lastEndDate.getTime() === currentDate.getTime()) {
                        startFromTime = lastEndTime;
                    }
                }

                // Reschedule this work order
                // In the sequential scheduling endpoint, update the scheduleSingleWorkOrder call:
                // Change this line in the for loop:

                const scheduledSegments = await scheduleSingleWorkOrder(
                    workOrder,
                    currentDate,
                    manufacturingOrderId,
                    colorCode,
                    req.user.id,
                    startFromTime,
                    false // isReschedule = false for new scheduling
                );

                if (scheduledSegments.length === 0) {
                    console.log(`Could not reschedule ${workOrder.workOrderNumber}`);
                    continue;
                }

                // Update work order timeline
                workOrder.status = "scheduled";
                workOrder.timeline.scheduledStartDate = scheduledSegments[0].startTime;
                workOrder.timeline.scheduledEndDate = scheduledSegments[scheduledSegments.length - 1].endTime;
                await workOrder.save();

                // Update for next work order
                const lastSegment = scheduledSegments[scheduledSegments.length - 1];
                lastEndTime = lastSegment.endTime;
                currentDate = normalizeDate(lastSegment.date);

                // Check if we should continue on same day
                const schedule = await ProductionSchedule.findOne({ date: currentDate });
                if (schedule && (schedule.workHours.isActive || (currentDate.getUTCDay() === 0 && schedule.isSundayOverride))) {
                    const workEnd = parseTimeOnDate(schedule.workHours.endTime, currentDate);
                    if (lastEndTime < workEnd) {
                        // Continue on same day
                        console.log(`Continuing on same day: ${currentDate.toISOString()}`);
                    } else {
                        // Move to next day
                        currentDate = new Date(currentDate);
                        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
                        lastEndTime = null;
                        console.log(`Moving to next day: ${currentDate.toISOString()}`);
                    }
                } else {
                    // Move to next active day
                    currentDate = new Date(currentDate);
                    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
                    lastEndTime = null;
                    console.log(`Moving to next active day: ${currentDate.toISOString()}`);
                }
            }
        }

        // Clean up any empty schedules
        await ProductionSchedule.deleteMany({
            date: { $gte: fromDate },
            scheduledWorkOrders: { $size: 0 }
        });

        console.log("Rescheduling completed successfully");

    } catch (error) {
        console.error("Error in rescheduleFromDate:", error);
        throw error;
    }
};

// FIXED: GET day settings
router.get("/day-settings/:date", async (req, res) => {
    try {
        const { date } = req.params;
        const dateObj = normalizeDate(date);
        const isSunday = dateObj.getUTCDay() === 0;

        let schedule = await ProductionSchedule.findOne({ date: dateObj });

        if (!schedule) {
            // Create default schedule
            schedule = new ProductionSchedule({
                date: dateObj,
                workHours: {
                    startTime: "09:30",
                    endTime: "18:30",
                    totalMinutes: 540,
                    isActive: !isSunday, // Sundays inactive by default
                    customHours: false
                },
                defaultBreaks: [
                    {
                        name: "Lunch Break",
                        startTime: "13:00",
                        endTime: "13:45",
                        durationMinutes: 45,
                        isFixed: true
                    },
                    {
                        name: "Evening Tea Break",
                        startTime: "17:00",
                        endTime: "17:15",
                        durationMinutes: 15,
                        isFixed: true
                    }
                ],
                breaks: [],
                isHoliday: isSunday,
                isSundayOverride: false,
                holidayReason: isSunday ? "Sunday - Day Off" : ""
            });
        }

        res.json({
            success: true,
            schedule
        });

    } catch (error) {
        console.error("Error fetching day settings:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching day settings"
        });
    }
});

// GET schedule for specific day
router.get("/day/:date", async (req, res) => {
    try {
        const { date } = req.params;
        const dateObj = normalizeDate(date);

        const schedule = await ProductionSchedule.findOne({ date: dateObj })
            .populate("scheduledWorkOrders.workOrderId", "workOrderNumber stockItemName quantity status")
            .populate("scheduledWorkOrders.manufacturingOrderId", "requestId");

        if (!schedule) {
            return res.json({
                success: true,
                schedule: null
            });
        }

        res.json({
            success: true,
            schedule
        });

    } catch (error) {
        console.error("Error fetching day schedule:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching day schedule"
        });
    }
});

// Remove work order from schedule
router.delete("/remove-schedule/:scheduleId/:workOrderScheduleId", async (req, res) => {
    try {
        const { scheduleId, workOrderScheduleId } = req.params;

        const schedule = await ProductionSchedule.findById(scheduleId);
        if (!schedule) {
            return res.status(404).json({
                success: false,
                message: "Schedule not found"
            });
        }

        // Find and remove the work order
        const workOrderIndex = schedule.scheduledWorkOrders.findIndex(
            wo => wo._id.toString() === workOrderScheduleId
        );

        if (workOrderIndex === -1) {
            return res.status(404).json({
                success: false,
                message: "Work order not found in schedule"
            });
        }

        const removedWorkOrder = schedule.scheduledWorkOrders[workOrderIndex];

        // Remove from schedule
        schedule.scheduledWorkOrders.splice(workOrderIndex, 1);
        await schedule.save();

        // Update work order status
        await WorkOrder.findByIdAndUpdate(removedWorkOrder.workOrderId, {
            status: "planned",
            "timeline.scheduledStartDate": null,
            "timeline.scheduledEndDate": null
        });

        res.json({
            success: true,
            message: "Work order removed from schedule"
        });

    } catch (error) {
        console.error("Error removing work order from schedule:", error);
        res.status(500).json({
            success: false,
            message: "Server error while removing work order"
        });
    }
});

// Update work order schedule time
router.put("/update-schedule/:scheduleId/:workOrderScheduleId", async (req, res) => {
    try {
        const { scheduleId, workOrderScheduleId } = req.params;
        const { scheduledStartTime, scheduledEndTime } = req.body;

        const schedule = await ProductionSchedule.findById(scheduleId);
        if (!schedule) {
            return res.status(404).json({
                success: false,
                message: "Schedule not found"
            });
        }

        // Find the work order
        const workOrder = schedule.scheduledWorkOrders.find(
            wo => wo._id.toString() === workOrderScheduleId
        );

        if (!workOrder) {
            return res.status(404).json({
                success: false,
                message: "Work order not found in schedule"
            });
        }

        // Update times
        workOrder.scheduledStartTime = new Date(scheduledStartTime);
        workOrder.scheduledEndTime = new Date(scheduledEndTime);
        workOrder.durationMinutes = calculateMinutesBetween(
            workOrder.scheduledStartTime,
            workOrder.scheduledEndTime
        );

        await schedule.save();

        // Update work order timeline
        await WorkOrder.findByIdAndUpdate(workOrder.workOrderId, {
            "timeline.scheduledStartDate": workOrder.scheduledStartTime,
            "timeline.scheduledEndDate": workOrder.scheduledEndTime
        });

        res.json({
            success: true,
            message: "Work order schedule updated successfully"
        });

    } catch (error) {
        console.error("Error updating work order schedule:", error);
        res.status(500).json({
            success: false,
            message: "Server error while updating work order schedule"
        });
    }
});

// Helper functions
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function generateColorCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"];
    return colors[Math.abs(hash) % colors.length];
}

module.exports = router;



// see the below codes, Basically 