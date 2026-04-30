// GRAV-CMS-BACKEND/routes/services/googleTasksService.js
const { google } = require("googleapis");
const { getOAuth2Client } = require("./googleAuthService");

function getTasksClient() {
    return google.tasks({ version: "v1", auth: getOAuth2Client() });
}

async function getTaskLists() {
    const tasks = getTasksClient();
    const res = await tasks.tasklists.list({ maxResults: 20 });
    return (res.data.items || []).map(l => ({ id: l.id, title: l.title, updated: l.updated }));
}

async function getTasksInList(listId, pageToken = "") {
    const tasks = getTasksClient();
    const params = { tasklist: listId, showCompleted: true, showHidden: false, maxResults: 100 };
    if (pageToken) params.pageToken = pageToken;
    const res = await tasks.tasks.list(params);
    return (res.data.items || []).map(formatTask);
}

async function getAllTasks() {
    const lists = await getTaskLists();
    const results = await Promise.allSettled(lists.map(l => getTasksInList(l.id)));
    return lists.map((list, i) => ({
        listId: list.id,
        listTitle: list.title,
        tasks: results[i].status === "fulfilled" ? results[i].value : [],
    }));
}

async function getAllTasksFlat() {
    const byList = await getAllTasks();
    const tasks = [];
    const stats = { total: 0, completed: 0, pending: 0 };
    const byListMap = {};
    for (const list of byList) {
        byListMap[list.listTitle] = list.tasks;
        for (const t of list.tasks) {
            tasks.push({ ...t, listId: list.listId, listTitle: list.listTitle });
            stats.total++;
            if (t.status === "completed") stats.completed++;
            else stats.pending++;
        }
    }
    return { tasks, stats, byList: byListMap };
}

async function createGoogleTask(tasklistId, { title, notes = "", due = null }) {
    const tasks = getTasksClient();
    const body = { title, notes };
    if (due) body.due = new Date(due).toISOString();
    const res = await tasks.tasks.insert({ tasklist: tasklistId, resource: body });
    return formatTask(res.data);
}

async function createSubtask(tasklistId, parentTaskId, { title, notes = "" }) {
    const tasks = getTasksClient();
    const res = await tasks.tasks.insert({
        tasklist: tasklistId, parent: parentTaskId,
        resource: { title, notes },
    });
    return formatTask(res.data);
}

async function updateGoogleTask(tasklistId, taskId, updates) {
    const tasks = getTasksClient();
    const existing = await tasks.tasks.get({ tasklist: tasklistId, task: taskId });
    const merged = { ...existing.data, ...updates };
    const res = await tasks.tasks.update({ tasklist: tasklistId, task: taskId, resource: merged });
    return formatTask(res.data);
}

function formatTask(t) {
    return {
        id: t.id, title: t.title || "(Untitled)",
        notes: t.notes || "", status: t.status || "needsAction",
        due: t.due || null, completed: t.completed || null,
        updated: t.updated, position: t.position,
        parent: t.parent || null,
        links: t.links || [],
    };
}

module.exports = { getTaskLists, getTasksInList, getAllTasks, getAllTasksFlat, createGoogleTask, createSubtask, updateGoogleTask };