#!/usr/bin/env node
// Subfolder assignment: the parent volume carries the highlight, not the
// subfolder, and a chosen subfolder no longer gets its own Volumes tile.
//
// Reproduces the exact reported case — one drive, one subfolder as source
// and a different subfolder as destination — against whatever drive is
// actually mounted.
//
// Run: node scripts/e2e-subfolder.js
const { spawn } = require("node:child_process");
const { spawnElectron } = require("./lib/electron-harness");
const fs=require("node:fs/promises"); const path=require("node:path"), os=require("node:os");
const APP=require("node:path").join(__dirname, "..");
const PORT=9301; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fail=0; const check=(ok,l,d="")=>{ if(!ok)fail++; console.log(`  ${ok?"PASS":"FAIL"}  ${l}${d?"  — "+d:""}`); };
(async()=>{
  // A leftover Electron on this port serves the OLD page, which has now
  // twice made a real fix look like it didn't apply.
  try { require("child_process").execSync("pkill -f 'remote-debugging-port=" + PORT + "' || true"); } catch {}
  await sleep(1200);
  const child=spawnElectron(path.join(APP,"node_modules",".bin","electron"),[APP,`--remote-debugging-port=${PORT}`],{stdio:"ignore"});
  let page;for(let i=0;i<80;i++){try{const t=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page=t.find(x=>x.type==="page"&&x.url.includes("index.html"));if(page?.webSocketDebuggerUrl)break;}catch{}await sleep(250);}
  const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener("open",r));
  let id=0;const pend=new Map();
  ws.addEventListener("message",e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const send=(me,pa={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method:me,params:pa}));});
  const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description);return r.result.value;};
  const shot=async f=>{const s=await send("Page.captureScreenshot",{format:"png"});await fs.writeFile(f,Buffer.from(s.data,"base64"));};
  await send("Runtime.enable"); await sleep(1200);

  // Reproduce the screenshot exactly: RB_Padel with Prints + PROG subfolders.
  const drive = await ev(`(volumes.find(v=>v.type==='removable')||volumes[0]).mountPoint`);
  const name  = await ev(`(volumes.find(v=>v.type==='removable')||volumes[0]).name`);
  const PROG = drive + "/PROG", PRINTS = drive + "/Prints";
  console.log(`Drive: ${name} (${drive})\n  source=${PROG}\n  dest  =${PRINTS}\n`);

  console.log("1. Subfolders no longer get their own Volumes tiles");
  await ev(`volumesView='square';
    extraFolders=[${JSON.stringify(PROG)},${JSON.stringify(PRINTS)}];
    sourcePath=${JSON.stringify(PROG)};
    destNodes=[{id:'d1',path:${JSON.stringify(PRINTS)},parentId:null}];
    render(); true`);
  check(await ev(`document.querySelectorAll('#zone-volumes .tile[data-path="${PROG}"]').length`)===0, "PROG has no Volumes tile");
  check(await ev(`document.querySelectorAll('#zone-volumes .tile[data-path="${PRINTS}"]').length`)===0, "Prints has no Volumes tile");
  check(await ev(`document.querySelectorAll('#zone-volumes .tile[data-path="${drive}"]').length`)===1, "the parent drive still has exactly one tile");
  check(await ev(`document.querySelectorAll('#zone-source .tile[data-path="${PROG}"]').length`)===1, "PROG still visible in Sources");
  check(await ev(`document.querySelectorAll('#zone-dest .tile[data-path="${PRINTS}"]').length`)===1, "Prints still visible in Destinations");

  console.log("\n2. The drive carries the split highlight");
  const cls = await ev(`document.querySelector('#zone-volumes .tile[data-path="${drive}"]').className`);
  check(cls.includes("role-both"), "drive tile marked role-both", cls);
  check(!cls.includes("self-assigned"), "drive is NOT dimmed — it holds no role itself, only contains them");
  const badges = await ev(`[...document.querySelectorAll('#zone-volumes .tile[data-path="${drive}"] .tile-role')].map(b=>b.textContent)`);
  check(JSON.stringify(badges)===JSON.stringify(["Source","Dest"]), "both badges stacked on the drive", badges.join("+"));
  const bg = await ev(`getComputedStyle(document.querySelector('#zone-volumes .tile[data-path="${drive}"]')).backgroundImage`);
  check(bg.includes("linear-gradient") && bg.includes("135deg"), "split gradient applied", bg.slice(0,70)+"…");
  const radius = await ev(`getComputedStyle(document.querySelector('#zone-volumes .tile[data-path="${drive}"]')).borderRadius`);
  check(radius==="8px", "corners still rounded (border-image would have squared them)", radius);
  await shot("/tmp/sf-both.png");

  console.log("\n3. Source-only and destination-only");
  await ev(`destNodes=[]; render(); true`);
  check((await ev(`document.querySelector('#zone-volumes .tile[data-path="${drive}"]').className`)).includes("role-src"), "source only → role-src");
  await ev(`sourcePath=null; destNodes=[{id:'d1',path:${JSON.stringify(PRINTS)},parentId:null}]; render(); true`);
  const dOnly = await ev(`document.querySelector('#zone-volumes .tile[data-path="${drive}"]').className`);
  check(dOnly.includes("role-dst"), "destination only → role-dst", dOnly);
  const dBorder = await ev(`getComputedStyle(document.querySelector('#zone-volumes .tile[data-path="${drive}"]')).borderColor`);
  check(dBorder.includes("45, 212, 191"), "destination border is turquoise, not blue", dBorder);
  await shot("/tmp/sf-dst.png");

  console.log("\n4. Whole-volume assignment must not regress");
  await ev(`clearAll(); extraFolders=[]; sourcePath=${JSON.stringify(drive)}; render(); true`);
  const whole = await ev(`document.querySelector('#zone-volumes .tile[data-path="${drive}"]').className`);
  check(whole.includes("role-src"), "whole drive as source → blue", whole);
  check(whole.includes("self-assigned"), "AND dimmed, because the drive itself is placed");
  await ev(`sourcePath=null; destNodes=[{id:'d1',path:${JSON.stringify(drive)},parentId:null}]; render(); true`);
  check((await ev(`document.querySelector('#zone-volumes .tile[data-path="${drive}"]').className`)).includes("role-dst"), "whole drive as dest → turquoise");

  console.log("\n5. The same three states survive a re-render (one renderer now, §22f)");
  await ev(`volumesView='line'; sourcePath=${JSON.stringify(PROG)};
    destNodes=[{id:'d1',path:${JSON.stringify(PRINTS)},parentId:null}];
    extraFolders=[${JSON.stringify(PROG)},${JSON.stringify(PRINTS)}]; render(); true`);
  const lc = await ev(`document.querySelector('#zone-volumes .tile[data-path="${drive}"]').className`);
  check(lc.includes("role-both"), "re-rendered tile still role-both", lc);
  check(await ev(`document.querySelectorAll('#zone-volumes .tile[data-path="${PROG}"]').length`)===0, "and still no subfolder rows");
  await shot("/tmp/sf-list.png");

  console.log("\n6. A folder with no parent volume still gets a tile");
  const orphan = (await fs.mkdtemp(path.join(os.tmpdir(),"orphan-")));
  await ev(`clearAll(); extraFolders=[${JSON.stringify(orphan)}]; volumesView='square'; render(); true`);
  check(await ev(`deviceFor(${JSON.stringify(orphan)})`)===null, "temp dir has no resolvable parent volume");
  check(await ev(`document.querySelectorAll('#zone-volumes .tile[data-path="${orphan}"]').length`)===1,
    "so it keeps its own tile rather than vanishing");
  await fs.rm(orphan,{recursive:true,force:true});

  console.log(fail===0 ? "\nALL CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`);
  child.kill("SIGKILL"); process.exit(fail?1:0);
})();
