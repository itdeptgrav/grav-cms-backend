// GRAV-CMS-BACKEND/services/googleCalendarService.js
const { google } = require("googleapis");
const { getOAuth2Client } = require("./googleAuthService");

// Get list of all calendars
async function getCalendars() {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const res = await calendar.calendarList.list();
  return (res.data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    description: c.description || "",
    backgroundColor: c.backgroundColor || "#1a73e8",
    primary: c.primary || false,
  }));
}

// Get upcoming events (next 30 days) from all calendars
async function getUpcomingEvents(days = 30, maxResults = 50) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const later = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: later.toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  return (res.data.items || []).map((e) => ({
    id: e.id,
    title: e.summary || "(No title)",
    description: e.description || "",
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
    allDay: !!e.start?.date,
    location: e.location || "",
    attendees: (e.attendees || []).map((a) => ({ email: a.email, name: a.displayName || "", status: a.responseStatus })),
    status: e.status, // confirmed | tentative | cancelled
    hangoutLink: e.hangoutLink || null,
    creator: e.creator?.email || "",
    colorId: e.colorId || null,
  }));
}

// Get today's events only
async function getTodayEvents() {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    maxResults: 20,
    singleEvents: true,
    orderBy: "startTime",
  });
  return (res.data.items || []).map((e) => ({
    id: e.id,
    title: e.summary || "(No title)",
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
    allDay: !!e.start?.date,
    hangoutLink: e.hangoutLink || null,
    attendees: (e.attendees || []).length,
  }));
}

// Create a calendar event
async function createEvent(eventData) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: eventData.title,
      description: eventData.description || "",
      start: { dateTime: eventData.start, timeZone: "Asia/Kolkata" },
      end: { dateTime: eventData.end, timeZone: "Asia/Kolkata" },
      attendees: (eventData.attendees || []).map((email) => ({ email })),
    },
  });
  return res.data;
}

module.exports = { getCalendars, getUpcomingEvents, getTodayEvents, createEvent };
