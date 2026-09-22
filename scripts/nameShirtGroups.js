/*
 * NAME THE SHIRT'S GROUPS PROPERLY AND FIX THE ONE THAT MEASURES THE WRONG THING.
 *
 * Names come from grav-cms/lib/shirtGroupCatalogue.js, matched by part key
 * (names are for people; keys are what the rules use). One correction: the
 * group drawn as "SleeveWidth" on the sleeve runs top-to-bottom - it is the
 * sleeve LENGTH (20.5" of a 24" chart sleeve; the cuff carries 3.5"), so it
 * gets the chart key, x1 and a -3.5" offset. Idempotent; run after any
 * re-upload of size M.   node scripts/nameShirtGroups.js
 */
require("dotenv").config(); const mongoose=require("mongoose"); const { pathToFileURL } = require("node:url");
(async()=>{
 const { SHIRT_STANDARD_GROUPS } = await import(pathToFileURL("C:/Users/soumy/Desktop/grav-cms/lib/shirtGroupCatalogue.js").href);
 const { measureGroupInches } = await import(pathToFileURL("C:/Users/soumy/Desktop/grav-cms/lib/patternMeasure.js").href);
 await mongoose.connect(process.env.MONGODB_URI); const db=mongoose.connection.db;
 const q={stockItemId:new mongoose.Types.ObjectId("69bbcb3d1c32e4f8d5b30a46"),isActive:true};
 const cfg=await db.collection("patterngradingconfigs").findOne(q,{sort:{updatedAt:-1}});
 const sp=cfg.sizePatterns.find(s=>s.sizeName==="M"); const next=sp.keyframeGroups.map(g=>({...g}));
 const byKey=Object.fromEntries(SHIRT_STANDARD_GROUPS.map(g=>[g.key,g]));
 const mark=(g,replaced)=>{ if(!Object.keys(replaced).length) return; g.tuned={at:new Date().toISOString(),by:"script",replaced:{...(g.tuned?.replaced||{}),...replaced}}; };
 // 1. the mis-labelled sleeve group
 for (const g of next) if ((g.groupName||g.name)==="SleeveWidth" && g.partKey==="__custom__sleevewidth") {
   const replaced={partKey:g.partKey, multiplier:g.multiplier, measurementOffset:g.measurementOffset||0};
   g.partKey="Sleeve Length"; g.multiplier=1; g.measurementOffset=-3.5;
   g.baseFullInches=Number(measureGroupInches(sp.basePaths,g,25.4).toFixed(4)); if(Math.abs(Number(g.targetFullInches)||0)>0) g.targetFullInches=g.baseFullInches;
   mark(g,replaced); console.log('SleeveWidth -> Sleeve Length x1 off -3.5 base', g.baseFullInches); }
 // 2. names from the catalogue (the yoke's own yokeseam group gets its own name)
 for (const g of next) { const c=byKey[g.partKey]; if(!c) { console.log('no catalogue entry for', g.groupName, g.partKey); continue; }
   let name=c.label; if (g.partKey==="__custom__yokeseam" && g.ref1.pathIdx!==4) name="Yoke seam — yoke edge";
   if ((g.groupName||g.name)!==name) { console.log((g.groupName||g.name).padEnd(16),'->',name); g.groupName=name; g.name=name; } }
 await db.collection("patterngradingconfigs").updateOne({_id:cfg._id,"sizePatterns.sizeName":"M"},{$set:{"sizePatterns.$.keyframeGroups":next}});
 console.log('written'); await mongoose.disconnect();
})().catch(e=>{console.error(e);process.exit(1);});
