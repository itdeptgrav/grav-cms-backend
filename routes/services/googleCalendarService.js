// GRAV-CMS-BACKEND/routes/services/googleCalendarService.js
const { google } = require("googleapis");
const { getOAuth2Client } = require("./googleAuthService");

function getCalendarClient() {
    return google.calendar({ version: "v3", auth: getOAuth2Client() });
}

async function getCalendars() {
    const cal = getCalendarClient();
    const res = await cal.calendarList.list();
    return (res.data.items || []).map(c => ({
        id: c.id, summary: c.summary, description: c.description,
        primary: c.primary || false, backgroundColor: c.backgroundColor,
    }));
}

async function getUpcomingEvents(days = 30) {
    const cal = getCalendarClient();
    const now = new Date();
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const res = await cal.events.list({
        calendarId: "primary", timeMin: now.toISOString(),
        timeMax: end.toISOString(), singleEvents: true,
        orderBy: "startTime", maxResults: 50,
    });
    return (res.data.items || []).map(formatEvent);
}

async function getTodayEvents() {
    const cal = getCalendarClient();
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const res = await cal.events.list({
        calendarId: "primary", timeMin: start.toISOString(),
        timeMax: end.toISOString(), singleEvents: true, orderBy: "startTime",
    });
    return (res.data.items || []).map(formatEvent);
}

async function createEvent(eventData) {
    const cal = getCalendarClient();
    const res = await cal.events.insert({ calendarId: "primary", resource: eventData });
    return formatEvent(res.data);
}

function formatEvent(e) {
    return {
        id: e.id, summary: e.summary || "(No title)",
        description: e.description || "",
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        allDay: !!e.start?.date && !e.start?.dateTime,
        location: e.location || "",
        htmlLink: e.htmlLink || "",
        status: e.status || "confirmed",
        attendees: (e.attendees || []).map(a => ({ email: a.email, name: a.displayName, responseStatus: a.responseStatus })),
    };
}

module.exports = { getCalendars, getUpcomingEvents, getTodayEvents, createEvent };