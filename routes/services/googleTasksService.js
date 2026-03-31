

const { google } = require("googleapis");
const { getOAuth2Client } = require("./googleAuthService");

async function getTaskLists() {
    try {
        const auth = getOAuth2Client();
        const tasks = google.tasks({ version: "v1", auth });
        const res = await tasks.tasklists.list({ maxResults: 100 });
        return res.data.items || [];
    } catch (err) {
        console.error("getTaskLists error:", err.message);
        return [];
    }
}

async function getTasksInList(tasklistId, listTitle) {
    try {
        const auth = getOAuth2Client();
        const tasks = google.tasks({ version: "v1", auth });
        const res = await tasks.tasks.list({
            tasklist: tasklistId,
            showCompleted: true,
            showHidden: true,
            showDeleted: false,
            maxResults: 100,
        });
        const items = res.data.items || [];
        const parents = items.filter((t) => !t.parent);
        const children = items.filter((t) => t.parent);
        return parents.map((t) => ({
            id: t.id,
            title: t.title || "(Untitled)",
            status: t.status,
            due: t.due || null,
            notes: t.notes || "",
            completed: t.completed || null,
            updated: t.updated,
            listId: tasklistId,
            listTitle: listTitle,
            subtasks: children
                .filter((c) => c.parent === t.id)
                .map((c) => ({
                    id: c.id,
                    title: c.title || "(Untitled)",
                    status: c.status,
                    due: c.due || null,
                    notes: c.notes || "",
                    completed: c.completed || null,
                    updated: c.updated,
                    listId: tasklistId,
                    listTitle: listTitle,
                    parent: t.id,
                })),
        }));
    } catch (err) {
        console.error("getTasksInList error:", err.message);
        return [];
    }
}

async function getAllTasks() {
    const lists = await getTaskLists();
    if (!lists.length) return [];
    const results = await Promise.all(
        lists.map(async (list) => {
            const tasks = await getTasksInList(list.id, list.title);
            return { listId: list.id, listTitle: list.title, tasks };
        })
    );
    return results;
}

async function getAllTasksFlat() {
    const lists = await getTaskLists();
    if (!lists.length) return { tasks: [], stats: {}, byList: {} };
    const allListTasks = await Promise.all(
        lists.map((list) => getTasksInList(list.id, list.title))
    );
    const flat = allListTasks.flat();
    const now = new Date();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const total = flat.length;
    const completed = flat.filter((t) => t.status === "completed").length;
    const pending = flat.filter((t) => t.status === "needsAction").length;
    const overdue = flat.filter((t) => t.status === "needsAction" && t.due && new Date(t.due) < now).length;
    const dueToday = flat.filter((t) => {
        if (!t.due || t.status === "completed") return false;
        const d = new Date(t.due);
        return d >= today && d < tomorrow;
    }).length;
    const byList = {};
    flat.forEach((t) => {
        if (!byList[t.listTitle]) byList[t.listTitle] = { total: 0, pending: 0, completed: 0 };
        byList[t.listTitle].total++;
        if (t.status === "completed") byList[t.listTitle].completed++;
        else byList[t.listTitle].pending++;
    });
    return { tasks: flat, stats: { total, completed, pending, overdue, dueToday }, byList };
}

async function createGoogleTask(tasklistId, taskData) {
    const auth = getOAuth2Client();
    const tasks = google.tasks({ version: "v1", auth });
    const res = await tasks.tasks.insert({
        tasklist: tasklistId,
        requestBody: {
            title: taskData.title,
            notes: taskData.notes || "",
            due: taskData.due || undefined,
            status: "needsAction",
        },
    });
    return res.data;
}

async function createSubtask(tasklistId, parentTaskId, subtaskData) {
    const auth = getOAuth2Client();
    const tasks = google.tasks({ version: "v1", auth });
    const res = await tasks.tasks.insert({
        tasklist: tasklistId,
        parent: parentTaskId,
        requestBody: {
            title: subtaskData.title,
            notes: subtaskData.notes || "",
            status: "needsAction",
        },
    });
    return res.data;
}

async function updateGoogleTask(tasklistId, taskId, updates) {
    const auth = getOAuth2Client();
    const tasks = google.tasks({ version: "v1", auth });
    const res = await tasks.tasks.patch({
        tasklist: tasklistId,
        task: taskId,
        requestBody: updates,
    });
    return res.data;
}

module.exports = {
    getTaskLists,
    getTasksInList,
    getAllTasks,
    getAllTasksFlat,
    createGoogleTask,
    createSubtask,
    updateGoogleTask,
};