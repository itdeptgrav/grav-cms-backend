const { google } = require("googleapis");

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const tasks = google.tasks({
  version: "v1",
  auth: oauth2Client,
});

const getTasks = async () => {
  try {
    const taskLists = await tasks.tasklists.list();

    let allTasks = [];

    for (const list of taskLists.data.items) {
      const res = await tasks.tasks.list({
        tasklist: list.id,
      });

      if (res.data.items) {
        const formatted = res.data.items.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          due: task.due,
          updated: task.updated,
          listName: list.title,
        }));

        allTasks = [...allTasks, ...formatted];
      }
    }

    return allTasks;
  } catch (error) {
    console.error("Google Tasks Fetch Error:", error);
    throw error;
  }
};

module.exports = { getTasks };