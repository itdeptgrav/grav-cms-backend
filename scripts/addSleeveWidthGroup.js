/*
 * THE SLEEVE NEEDS A WIDTH BEFORE ITS CAP CAN FOLLOW THE ARMHOLE.
 *
 * With only a length on it, the sleeve cannot get narrower, and a cap that
 * has to lose 2.8" on a 32" chest has nowhere to go (its flattest is 16.4").
 * The catalogue's "Sleeve width at underarm" (__custom__sleevewidth, x2,
 * follows the chest in the master's ratio) runs between the cap's two ends -
 * the underarm corners. This adds it, with the connector that makes it a
 * straight measurement. Idempotent.   node scripts/addSleeveWidthGroup.js
 */
require("dotenv").config(); const mongoose=require("mongoose"); const { pathToFileURL } = require("node:url");
(async()=>{
 const { measureGroupInches } = await import(pathToFileURL("C:/Users/soumy/Desktop/grav-cms/lib/patternMeasure.js").href);
 await mongoose.connect(process.env.MONGODB_URI); const db=mongoose.connection.db;
 const q={stockItemId:new mongoose.Types.ObjectId("69bbcb3d1c32e4f8d5b30a46"),isActive:true};
 const cfg=await db.collection("patterngradingconfigs").findOne(q,{sort:{updatedAt:-1}});
 const sp=cfg.sizePatterns.find(s=>s.sizeName==="M"); const paths=sp.basePaths.map(p=>({...p})); const groups=sp.keyframeGroups.map(g=>({...g}));
 const cap=groups.find(g=>g.partKey==="__custom__sleevecap"); if(!cap) throw new Error("no sleeve cap group");
 const a=cap.ref1, b=cap.ref2; // the cap's ends are the underarm corners
 const linked=paths.some(p=>p.isConnector&&p.connectorFrom&&((p.connectorFrom.pi===a.pathIdx&&p.connectorFrom.si===a.segIdx&&p.connectorTo.pi===b.pathIdx&&p.connectorTo.si===b.segIdx)||(p.connectorFrom.pi===b.pathIdx&&p.connectorFrom.si===b.segIdx&&p.connectorTo.pi===a.pathIdx&&p.connectorTo.si===a.segIdx)));
 if(!linked){ const n1=paths[a.pathIdx].segs[a.segIdx], n2=paths[b.pathIdx].segs[b.segIdx]; const pt=(n)=>({x:n.x,y:n.y,c1:{x:n.x,y:n.y},c2:{x:n.x,y:n.y}});
   paths.push({ id:`conn-sleevewidth-${Date.now()}`, isConnector:true, connectorFrom:{pi:a.pathIdx,si:a.segIdx}, connectorTo:{pi:b.pathIdx,si:b.segIdx}, isClosed:false, distance:Math.hypot(n2.x-n1.x,n2.y-n1.y)/25.4, segs:[{t:"M",...pt(n1)},{t:"L",...pt(n2)}] }); console.log('connector added'); }
 let g=groups.find(x=>x.partKey==="__custom__sleevewidth");
 if(!g){ const id=`grp-sleevewidth-${Date.now()}`; g={ clientId:id, groupId:id, name:"Sleeve width at underarm", groupName:"Sleeve width at underarm", partKey:"__custom__sleevewidth", assignedSize:"M", multiplier:2, ref1:{pathIdx:a.pathIdx,segIdx:a.segIdx}, ref2:{pathIdx:b.pathIdx,segIdx:b.segIdx}, color:"#d97706", targetFullInches:0, baseFullInches:0, measurementOffset:0, gradingMode:"parametric", measureMode:"auto", ruleProfile:null, loosingEnabled:false, loosingValueInches:0, loosingSide:"both", loosingValueRef1Inches:0, loosingValueRef2Inches:0, conditionsFollowLoosing:false, nestedConditions:[], keyframes:[], tuned:{at:new Date().toISOString(),by:"script",replaced:{}} }; groups.push(g); console.log('group added'); }
 g.baseFullInches=Number(measureGroupInches(paths,g,25.4).toFixed(4)); g.targetFullInches=g.baseFullInches; console.log('Sleeve width at underarm x2 base', g.baseFullInches);
 await db.collection("patterngradingconfigs").updateOne({_id:cfg._id,"sizePatterns.sizeName":"M"},{$set:{"sizePatterns.$.basePaths":paths,"sizePatterns.$.keyframeGroups":groups}});
 const fresh=await db.collection("patterngradingconfigs").findOne(q,{sort:{updatedAt:-1}}); require("fs").writeFileSync(process.argv[2]+"/sizeM.json", JSON.stringify(fresh.sizePatterns.find(s=>s.sizeName==="M"),null,1));
 console.log('written; M re-dumped'); await mongoose.disconnect();
})().catch(e=>{console.error(e);process.exit(1);});
