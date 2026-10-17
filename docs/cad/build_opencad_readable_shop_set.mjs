import process from "node:process";

const api = process.env.OCS_API_URL ?? "http://127.0.0.1:18090/api/v1";
const token = process.env.OCS_API_TOKEN ?? "codex-fabric-meter-2026";
const out = "/Users/risheeray/grav-cms-backend/docs/cad";

async function call(path, method = "GET", body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

let e = [];
const line = (a, b, c, d, layer = "OBJECT", color = 7) => e.push({ type: "Line", start: [a, b], end: [c, d], layer, color });
const rect = (x, y, w, h, layer = "OBJECT", color = 7) => e.push({ type: "LwPolyline", vertices: [[x,y],[x+w,y],[x+w,y+h],[x,y+h]], closed: true, layer, color });
const circle = (x, y, r, layer = "OBJECT", color = 7) => e.push({ type: "Circle", center: [x,y], radius: r, layer, color });
const text = (value, x, y, height = 25, layer = "TEXT", color = 7, rotation = 0) => e.push({ type: "Text", value, position: [x,y], height, layer, color, rotation_deg: rotation });
const arrow = (x1,y1,x2,y2,layer="FLOW",color=1) => {
  line(x1,y1,x2,y2,layer,color);
  const a=Math.atan2(y2-y1,x2-x1), s=28;
  line(x2,y2,x2-s*Math.cos(a-0.45),y2-s*Math.sin(a-0.45),layer,color);
  line(x2,y2,x2-s*Math.cos(a+0.45),y2-s*Math.sin(a+0.45),layer,color);
};
const hdim = (x1,x2,y0,yd,value) => {
  line(x1,y0,x1,yd,"DIM",2); line(x2,y0,x2,yd,"DIM",2); line(x1,yd,x2,yd,"DIM",2);
  line(x1,yd,x1+25,yd+10,"DIM",2); line(x1,yd,x1+25,yd-10,"DIM",2);
  line(x2,yd,x2-25,yd+10,"DIM",2); line(x2,yd,x2-25,yd-10,"DIM",2);
  text(value,(x1+x2)/2-value.length*7,yd+18,24,"DIM",2);
};
const vdim = (y1,y2,x0,xd,value) => {
  line(x0,y1,xd,y1,"DIM",2); line(x0,y2,xd,y2,"DIM",2); line(xd,y1,xd,y2,"DIM",2);
  line(xd,y1,xd-10,y1+25,"DIM",2); line(xd,y1,xd+10,y1+25,"DIM",2);
  line(xd,y2,xd-10,y2-25,"DIM",2); line(xd,y2,xd+10,y2-25,"DIM",2);
  text(value,xd-18,(y1+y2)/2-value.length*7,24,"DIM",2,90);
};

function sheet(number, title, subtitle) {
  e = [];
  rect(0,0,2100,1485,"SHEET",7); rect(35,35,2030,1415,"SHEET",7);
  line(35,180,2065,180,"SHEET",7);
  text(title,70,1390,48,"TITLE",7);
  text(subtitle,70,1335,20,"TITLE",7);
  rect(1260,35,805,145,"SHEET",7); line(1580,35,1580,180,"SHEET",7); line(1830,35,1830,180,"SHEET",7);
  text("FABRIC METER",1280,130,24,"TITLE",7);
  text(`S${number} / 4`,1280,82,21,"TEXT",7);
  text("REV C",1625,125,26,"TITLE",7);
  text("A3  1:5",1625,78,20,"TEXT",7);
  text("PROVISIONAL",1850,125,18,"TITLE",2);
  text("VERIFY FIRST",1850,78,18,"TEXT",2);
}

async function publish(number, slug) {
  await call("/documents", "POST", {});
  for (let i=0;i<e.length;i+=40) await call("/entities", "POST", { entities: e.slice(i,i+40) });
  await call("/layouts", "POST", { name: "A3-SHEET" });
  await call("/layouts/A3-SHEET/page-setup", "PUT", { paper: "ISO_A3_(420.00_x_297.00_MM)", orientation: "landscape", fit: true, center: true });
  const audit = await call("/audit", "POST", { target_format: "dwg", target_version: "2018" });
  const state = await call("/state");
  const stem = `Fabric_Roll_Meter_S0${number}_${slug}_RevC`;
  await call("/save_verified", "POST", { protocol:1, request_id:`save-${stem}-${state.document_id}`, document_id:state.document_id, revision:state.revision, path:`${out}/${stem}.dwg`, target_format:"dwg", target_version:"2018", overwrite:true });
  await call("/plot", "POST", { path:`${out}/${stem}_OCS.pdf`, layout:"Model", area:"window", window:[0,0,2100,1485], paper:"ISO_A3_(420.00_x_297.00_MM)", orientation:"landscape", scale:"1:5", center:true, lineweights:true, merge_lines:true });
  return { sheet:number, stem, entities:e.length, audit:audit.result?.summary ?? audit.summary };
}

const results=[];

// Sheet 1: plain-language machine overview and fabric path.
sheet(1,"HOW THE MACHINE WORKS","Large overview for the operator - fabric path and five simple operating steps");
text("FABRIC PATH - SIDE VIEW",90,1250,34,"TITLE",7);
rect(130,650,1750,45,"FRAME",3);
rect(170,650,45,520,"FRAME",3); rect(1810,650,45,520,"FRAME",3);
circle(430,1000,175,"FABRIC",8); circle(430,1000,38,"SHAFT",1);
circle(930,900,55,"ROLLER",5); circle(930,1030,45,"ROLLER",5);
circle(1500,790,120,"FABRIC",8); circle(1500,790,38,"SHAFT",1);
arrow(600,1000,875,945); arrow(930,955,930,985); arrow(975,985,1380,835);
text("1  SUPPLY ROLL",300,1210,30,"TEXT",7);
text("2  MEASURING ROLLER",745,1115,30,"TEXT",7);
text("3  SPRING NIP",815,1070,25,"TEXT",7);
text("4  MOTORIZED TAKE-UP",1320,980,30,"TEXT",7);
rect(1580,720,190,140,"DRIVE",1); text("GEAR",1640,805,25,"TEXT",1); text("MOTOR",1625,760,25,"TEXT",1);
text("The encoder measures fabric on the rubber roller.",180,595,25,"TEXT",7);
text("Roll diameter and GSM do not affect the metre reading.",180,555,25,"TEXT",7);
const steps=[
  ["1", "LOAD", "Full roll on", "supply shaft"],
  ["2", "THREAD", "Fabric between", "the two rollers"],
  ["3", "FIX", "Attach fabric", "to empty tube"],
  ["4", "RUN", "Reset; hold pedal", "set safe speed"],
  ["5", "STOP", "Release pedal", "read metres"],
];
steps.forEach((s,i)=>{const x=90+i*395; rect(x,260,360,220,"STEP",i===4?2:6); circle(x+45,430,25,"STEP",i===4?2:6); text(s[0],x+36,416,25,"TITLE",i===4?2:6); text(s[1],x+85,410,27,"TITLE",7); text(s[2],x+25,335,21,"TEXT",7); text(s[3],x+25,295,21,"TEXT",7);});
results.push(await publish(1,"Overview"));

// Sheet 2: frame and overall dimensions only.
sheet(2,"FRAME AND OVERALL SIZE","For the welder - all dimensions shown here are provisional until site measurements are confirmed");
text("FRONT VIEW",90,1260,34,"TITLE",7);
const fx=170,fy=620;
rect(fx,fy,1750,40,"FRAME",3); rect(fx,fy,40,520,"FRAME",3); rect(fx+1710,fy,40,520,"FRAME",3);
rect(fx+40,fy+40,1670,40,"FRAME",3);
for(const yy of [fy+170,fy+300,fy+410]){line(fx+90,yy,fx+1660,yy,"CENTER",4);rect(fx+50,yy-40,70,80,"BEARING",6);rect(fx+1630,yy-40,70,80,"BEARING",6);}
hdim(fx,fx+1750,fy,fy-95,"1750 OVERALL - PROVISIONAL"); hdim(fx+140,fx+1610,fy+520,fy+620,"1470 FABRIC CLEAR"); vdim(fy,fy+520,fx,fx-95,"520");
text("TOP VIEW",90,545,34,"TITLE",7);
const tx=170,ty=255; rect(tx,ty,1750,330,"FRAME",3); rect(tx+40,ty+40,1670,250,"FRAME",3);
for(const yy of [ty+75,ty+165,ty+255]) rect(tx+100,yy-25,1550,50,"ROLLER",5);
vdim(ty,ty+330,tx+1750,tx+1825,"450 PROV.");
text("FRAME: 40 x 40 x 2 mm MS SHS | 4 mm FILLET WELDS | ADD FEET AND GUARDS",220,205,18,"TEXT",7);
results.push(await publish(2,"Frame"));

// Sheet 3: rotating components.
sheet(3,"SHAFTS AND ROLLERS","For machining and purchasing - diameters and lengths remain provisional where marked");
text("MEASURING ROLLER",90,1250,34,"TITLE",7);
rect(230,1080,1550,100,"ROLLER",5); rect(150,1112,80,36,"SHAFT",1); rect(1780,1112,80,36,"SHAFT",1);
hdim(230,1780,1180,1235,"1550 ROLLER FACE"); vdim(1080,1180,1780,1880,"100 OD");
text("Rubber-lagged aluminium roller | Runout <= 0.20 mm TIR",480,1025,25,"TEXT",7);
text("SUPPLY / TAKE-UP SHAFT",90,900,34,"TITLE",7);
rect(200,760,1650,35,"SHAFT",1); rect(280,720,100,115,"BEARING",6); rect(1670,720,100,115,"BEARING",6);
hdim(200,1850,795,875,"1650 SHAFT - PROVISIONAL"); text("35 DIA EN8 / C45 SOLID SHAFT",725,690,28,"TEXT",7);
text("CORE CONE DETAIL",90,570,34,"TITLE",7);
line(300,390,850,390,"CENTER",4); rect(300,373,550,35,"SHAFT",1);
e.push({type:"LwPolyline",vertices:[[430,315],[650,355],[650,425],[430,465]],closed:true,layer:"CORE",color:6});
hdim(430,650,315,275,"ADJUSTABLE"); text("76 mm NOMINAL CORE - VERIFY RANGE",910,380,27,"TEXT",2);
text("BUY: 6 x UCP207 PILLOW BLOCKS",1050,545,21,"TEXT",7);
text("BEARING BORE: 35 mm",1050,510,21,"TEXT",7);
text("NIP: 80 OD x 1550; SPRING LOADED",1050,465,20,"TEXT",7);
text("ENCODER: 1024 PPR OR HIGHER",1050,425,20,"TEXT",7);
text("VERIFY MAXIMUM ROLL WIDTH BEFORE MACHINING SHAFTS.",360,235,23,"TITLE",2);
results.push(await publish(3,"Rotating_Parts"));

// Sheet 4: drive, controls, safety and concise BOM.
sheet(4,"DRIVE, CONTROLS AND PARTS","For the electrician and assembler - simple functional diagram, safety items and purchasing list");
text("CONTROL FLOW",90,1260,34,"TITLE",7);
const blocks=[
  [100,"230 V INPUT"],[430,"E-STOP"],[820,"0.55 kW VFD"],[1170,"GEARMOTOR"],[1510,"SLIP CLUTCH"],[1810,"TAKE-UP"]
];
blocks.forEach(([x,t])=>{rect(x,1080,240,110,"DRIVE",1); text(t,x+18,1122,20,"TEXT",7);});
for(let i=0;i<blocks.length-1;i++) arrow(blocks[i][0]+240,1135,blocks[i+1][0],1135,"FLOW",1);
text("FOOT PEDAL: HOLD TO RUN",420,1010,20,"TEXT",7); arrow(600,1000,820,1080,"FLOW",1);
text("SPEED: 0-20 m/min",1220,1010,20,"TEXT",7);
text("TARGET 5000 m / SHIFT | NORMAL 12-15 m/min | MAX 20 m/min",300,930,20,"TITLE",7);
text("COUNTER",90,875,34,"TITLE",7); circle(250,760,65,"SENSOR",5); text("ENCODER",175,665,22,"TEXT",7);
arrow(315,760,600,760,"FLOW",5); rect(600,695,330,130,"SENSOR",5); text("METRE DISPLAY",650,750,27,"TEXT",7);
text("SAFETY",1080,875,34,"TITLE",7);
const safety=["Large red E-STOP","Hold-to-run foot pedal","Fixed coupling/chain guards","Adjustable torque limiter","Earth the metal frame","No exposed pinch points"];
safety.forEach((s,i)=>text(`${i+1}. ${s}`,1100,815-i*40,21,"TEXT",i<4?2:7));
text("PURCHASE LIST",90,545,34,"TITLE",7);
const parts=[
  ["1","0.55 kW geared motor + VFD","1 set"],["2","UCP207 pillow-block bearings","6"],["3","1024 PPR incremental encoder","1"],
  ["4","100 OD measuring roller","1"],["5","80 OD spring nip roller","1"],["6","35 DIA EN8 shafts","2"],
  ["7","E-stop, pedal, isolator, enclosure","1 set"],["8","Torque limiter / slip clutch","1"],["9","Guards, feet and fasteners","1 set"]
];
rect(90,230,940,270,"SHEET",7); line(160,230,160,500,"SHEET",7); line(850,230,850,500,"SHEET",7);
for(let i=1;i<9;i++)line(90,230+i*30,1030,230+i*30,"SHEET",7);
parts.forEach((p,i)=>{const y=472-i*30;text(p[0],110,y,18);text(p[1],180,y,18);text(p[2],875,y,18);});
text("CALIBRATION",1110,545,34,"TITLE",7);
text("1. Thread fabric with low tension.",1110,480,20);
text("2. Reset and run a measured 10 m.",1110,440,20);
text("3. Correct the counter roller constant.",1110,400,20);
text("4. Test three 20 m runs; error <1%.",1110,360,20);
text("5. Repeat after changing roller covering.",1110,320,20);
results.push(await publish(4,"Drive_Controls_BOM"));

console.log(JSON.stringify({ok:true,results},null,2));
