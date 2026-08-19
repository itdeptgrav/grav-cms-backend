require("dotenv").config();
const https = require("https");
(async () => {
  const { google } = require("googleapis");
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  key.private_key = key.private_key.replace(/\n/g, "\n");
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: key.client_email, private_key: key.private_key },
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const drive = google.drive({ version: "v3", auth });
  const list = await drive.files.list({
    q: "mimeType contains 'image/' and trashed = false",
    orderBy: "createdTime desc",
    pageSize: 4,
    fields: "files(id,name,createdTime,permissions(type,role))",
  });
  const status = (url) => new Promise((resolve) => {
    https.get(url, { timeout: 8000 }, (r) => { r.resume(); resolve(r.statusCode); })
      .on("error", (e) => resolve("ERR " + e.message))
      .on("timeout", function(){ this.destroy(); resolve("TIMEOUT"); });
  });
  for (const f of list.data.files || []) {
    const perms = (f.permissions || []).map((p) => `${p.type}:${p.role}`).join(", ");
    const lh3 = await status(`https://lh3.googleusercontent.com/d/${f.id}=w1600`);
    const proxy = await status(`http://localhost:5000/cowork/media/view/${f.id}`).catch(()=> "n/a");
    console.log(`${f.createdTime}  ${f.name}`);
    console.log(`   id ${f.id}`);
    console.log(`   permissions: ${perms || "NONE — never made public"}`);
    console.log(`   lh3   -> ${lh3}`);
    console.log(`   proxy -> ${proxy}`);
    console.log("");
  }
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
