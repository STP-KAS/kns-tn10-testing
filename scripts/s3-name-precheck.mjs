import fs from "node:fs";
const API="https://api.knsdomains.org/tn10/api/v1/domains/check";
const addr="kaspatest:qqzzfgfh9h9jt2kvhw9dyvfzgc9qwdd6eelmdy9fu9wnhcaggj0pwlpa3wzpr";
const names=[]; for(let w=700;w<=20699;w++) for(let d=0;d<3;d++) names.push(`stp-s3-w${String(w).padStart(5,"0")}-d${d}.kas`);
const CH=Number(process.argv[2]||100); let avail=0, taken=[], errs=0;
for(let k=0;k<names.length;k+=CH){ const chunk=names.slice(k,k+CH);
  for(let a=0;a<3;a++){ try{ const r=await fetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({domainNames:chunk,address:addr})}); const j=await r.json(); for(const d of j.data.domains){ if(d.available&&!d.isReservedDomain) avail++; else taken.push(d.domain);} break; }catch(e){ errs++; await new Promise(r=>setTimeout(r,2000)); } }
  await new Promise(r=>setTimeout(r,150)); }
const res={total:names.length,available:avail,taken:taken.length,taken_list:taken.slice(0,50),errors:errs,at:new Date().toISOString()};
fs.writeFileSync("/workspace/artifacts/kns-tn10/snapshot-wallets/s3-name-precheck.json",JSON.stringify(res,null,2)+"\n");
console.log(JSON.stringify(res));
