require("dotenv").config();const m=require("mongoose");
(async()=>{await m.connect(process.env.MONGODB_URI);
const l=await m.connection.collection("leads").findOne({leadRef:"LEAD-2026-0021"});
if(!l){console.log("LEAD NOT FOUND");return}
const keys=Object.keys(l).filter(k=>/source|segment|pursuit|estimat|evidence|action|potential|review|capture/i.test(k));
keys.forEach(k=>console.log("  "+k+" = "+JSON.stringify(l[k]).slice(0,90)));
await m.disconnect();})().catch(e=>{console.error("ERR",e.message)});
