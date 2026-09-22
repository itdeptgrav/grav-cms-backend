/*
 * RE-APPLY THE SIZE-M CORRECTIONS (idempotent).
 *
 *   length         x1, measurementOffset -1     (a length is an offset, not a ratio)
 *   BackShoulder   chart Shoulder / raw           (copied x1.19431 reported 10.4" for 16.5")
 *   BackNeck       chart Coller  / raw            (copied x3.3343 reported 11.65" for 15")
 *   YokeBottomMark, yokeMark  partKey __custom__yokeseam  (a seam pair: cut equal)
 *
 * Each corrected group gets a `tuned` marker recording what it replaced, so a
 * save from a stale editor cannot hand the old value back. Run after any
 * re-upload of the size-M SVG.  node scripts/retuneSizeM.js
 */
require("dotenv").config(); const mongoose=require("mongoose"); const { pathToFileURL } = require("node:url");
(async()=>{
 const { measureGroupInches } = await import(pathToFileURL("C:/Users/soumy/Desktop/grav-cms/lib/patternMeasure.js").href);
 await mongoose.connect(process.env.MONGODB_URI); const db=mongoose.connection.db;
 const q={stockItemId:new mongoose.Types.ObjectId("69bbcb3d1c32e4f8d5b30a46"),isActive:true};
 const cfg=await db.collection("patterngradingconfigs").findOne(q,{sort:{updatedAt:-1}});
 const sp=cfg.sizePatterns.find(s=>s.sizeName==="M"); const next=sp.keyframeGroups.map(g=>({...g}));
 const byName=(n)=>next.find(g=>(g.groupName||g.name)===n);
 const raw=(g)=>measureGroupInches(sp.basePaths,{...g,multiplier:1},25.4);
 const chart={ Shoulder:16.5, Coller:15 };
 const tune=(n, fields)=>{ const g=byName(n); if(!g){console.log(n,'MISSING');return;}
   const replaced={}; for (const [k,v] of Object.entries(fields)) { if (String(g[k]??'')!==String(v)) replaced[k]=g[k]??(k==='measurementOffset'?0:g[k]); g[k]=v; }
   if ('multiplier' in fields || 'measurementOffset' in fields) { g.baseFullInches=Number((raw(g)*g.multiplier).toFixed(4)); if(Math.abs(Number(g.targetFullInches)||0)>0) g.targetFullInches=g.baseFullInches; }
   g.tuned={ at:new Date().toISOString(), by:"script", replaced:{...(g.tuned?.replaced||{}), ...replaced} };
   console.log(n.padEnd(15), JSON.stringify(fields), 'base', g.baseFullInches, Object.keys(replaced).length?('replaced '+JSON.stringify(replaced)):'(already)'); };
 tune('Front length', { multiplier:1, measurementOffset:-1 });
 tune('Back shoulder (yoke width)', { multiplier:Number((chart.Shoulder/raw(byName('Back shoulder (yoke width)'))).toFixed(4)) });
 tune('Back neck curve', { multiplier:Number((chart.Coller/raw(byName('Back neck curve'))).toFixed(4)) });
 tune('Yoke seam — yoke edge', { partKey:'__custom__yokeseam' });
 tune('Yoke seam — back body edge', { partKey:'__custom__yokeseam' });
 await db.collection("patterngradingconfigs").updateOne({_id:cfg._id,"sizePatterns.sizeName":"M"},{$set:{"sizePatterns.$.keyframeGroups":next}});
 console.log('written'); await mongoose.disconnect();
})().catch(e=>{console.error(e);process.exit(1);});
