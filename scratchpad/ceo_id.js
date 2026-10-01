const mongoose=require("mongoose");
(async()=>{await mongoose.connect(process.env.MONGODB_URI,{});
const d=await mongoose.connection.db.collection("dept_users").findOne({email:"ceo@grav.in"},{projection:{email:1,isAdmin:1,tokenVersion:1}});
console.log(JSON.stringify({id:String(d._id),email:d.email,isAdmin:d.isAdmin,tv:d.tokenVersion||0}));
await mongoose.disconnect();})().catch(e=>{console.error(e.message);process.exit(1)});
