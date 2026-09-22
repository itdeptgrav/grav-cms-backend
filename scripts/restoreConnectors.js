/*
 * RESTORE THE REFERENCE CONNECTORS THE EDITOR DROPPED.
 *
 * A group whose two refs sit on the same closed path is measured along the
 * outline unless a connector links exactly those two nodes, in which case it
 * is measured straight across. Moving the yoke in the editor deleted the three
 * connectors attached to it and to the back chest line, so BackChest,
 * BackShoulder and BackYokeLength silently became arcs. This puts the
 * connectors back, with their ends on the live node positions.
 *   node scripts/restoreConnectors.js
 */
require("dotenv").config(); const mongoose=require("mongoose");
const WANT = [ // [fromPath, fromSeg, toPath, toSeg]  (group refs, drawn as chords)
  [3, 3, 3, 6],   // BackYokeLength
  [3, 5, 3, 1],   // BackShoulder
  [4, 3, 4, 9],   // BackChest
];
(async()=>{ await mongoose.connect(process.env.MONGODB_URI); const db=mongoose.connection.db;
 const q={stockItemId:new mongoose.Types.ObjectId("69bbcb3d1c32e4f8d5b30a46"),isActive:true};
 const cfg=await db.collection("patterngradingconfigs").findOne(q,{sort:{updatedAt:-1}});
 const sp=cfg.sizePatterns.find(s=>s.sizeName==="M"); const paths=sp.basePaths.map(p=>({...p}));
 const has=(a,b,c,d)=>paths.some(p=>p.isConnector&&p.connectorFrom&&((p.connectorFrom.pi===a&&p.connectorFrom.si===b&&p.connectorTo.pi===c&&p.connectorTo.si===d)||(p.connectorFrom.pi===c&&p.connectorFrom.si===d&&p.connectorTo.pi===a&&p.connectorTo.si===b)));
 let added=0;
 for (const [a,b,c,d] of WANT) { if (has(a,b,c,d)) { console.log(`p${a}/${b}->p${c}/${d} already linked`); continue; }
   const n1=paths[a].segs[b], n2=paths[c].segs[d];
   const pt=(n)=>({x:n.x,y:n.y,c1:{x:n.x,y:n.y},c2:{x:n.x,y:n.y}});
   paths.push({ id:`conn-restored-${Date.now()}-${added}`, isConnector:true, connectorFrom:{pi:a,si:b}, connectorTo:{pi:c,si:d}, isClosed:false, distance:Math.hypot(n2.x-n1.x,n2.y-n1.y)/25.4, segs:[{t:"M",...pt(n1)},{t:"L",...pt(n2)}] });
   console.log(`restored p${a}/${b}->p${c}/${d}  ${(Math.hypot(n2.x-n1.x,n2.y-n1.y)/25.4).toFixed(2)}"`); added++; }
 if (added) await db.collection("patterngradingconfigs").updateOne({_id:cfg._id,"sizePatterns.sizeName":"M"},{$set:{"sizePatterns.$.basePaths":paths}});
 console.log(added? 'written':'nothing to do'); await mongoose.disconnect(); })().catch(e=>{console.error(e);process.exit(1);});
