// Line-by-line JS port of ranking.py's query-time scorer; compared against Python top-10.
// Takes a cases file (see report.py's dump_js_cases) and its weights as arguments.
import fs from 'node:fs';
const FOLD = {'æ':'ae','Æ':'ae','ø':'o','Ø':'o','ß':'ss','ł':'l','Ł':'l','đ':'d','Đ':'d','ð':'d','Ð':'d','þ':'th','Þ':'th','œ':'oe','Œ':'oe','ı':'i','ŋ':'n','ħ':'h','ŧ':'t'};
function fold(s){ let o=''; for (const c of s) o += (FOLD[c] ?? c); return o.normalize('NFKD').replace(/\p{Mn}/gu,'').toLowerCase(); }
function mergeSingles(r){ const out=[]; let i=0; while(i<r.length){ if(r[i].length===1){ let j=i; while(j<r.length && r[j].length===1) j++; out.push(r.slice(i,j).join('')); i=j; } else { out.push(r[i]); i++; } } return out; }
function nameTokens(name){ const runsAll=[], extras=[];
  for (const chunk of fold(name).split(/\s+/)) { const runs = chunk.match(/[a-z0-9]+/g); if (!runs) continue;
    if (runs.length>=2 && runs.every(r=>r.length<=2)) { runsAll.push(runs.join('')); extras.push(...runs); }
    else { runsAll.push(...runs); if (runs.length>=2) extras.push(runs.join('')); } }
  const seq = mergeSingles(runsAll); const seen = new Set(seq);
  return [seq, [...new Set(extras)].filter(x=>!seen.has(x) && x.length>=2)]; }
function queryTokens(q){ const toks=[]; for (const chunk of fold(q).split(/\s+/)) { const runs = chunk.match(/[a-z0-9]+/g); if (!runs) continue;
  if (runs.length>=2 && runs.every(r=>r.length<=2)) toks.push(runs.join('')); else toks.push(...runs); } return mergeSingles(toks); }
const STOP = new Set(['the','of','and','de','du','des','la','le','les','der','die','das','und','et','y','for','in','van','von','di','del','da','do','a','an']);
function prefixEditLe1(q,t){ const n=q.length, m=t.length; if (m<n-1) return false; const INF=9; let prev2=null, prev=[...Array(m+1).keys()];
  for (let i=1;i<=n;i++){ const cur=[i, ...Array(m).fill(INF)]; const lo=Math.max(1,i-1), hi=Math.min(m,i+1);
    for (let j=lo;j<=hi;j++){ const cost = q[i-1]===t[j-1]?0:1; let d=Math.min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost);
      if (i>1 && j>1 && q[i-1]===t[j-2] && q[i-2]===t[j-1]) d=Math.min(d, prev2[j-2]+1); cur[j]=d; }
    prev2=prev; prev=cur; }
  return Math.min(...prev.slice(Math.max(0,n-1), Math.min(m,n+1)+1)) <= 1; }
function level(q,t){ if (t===q) return 3; if (t.startsWith(q)) return 2; if (q.length>=4 && prefixEditLe1(q,t)) return 1; return 0; }
const D = JSON.parse(fs.readFileSync(process.argv[2])); const W = D.W;
function matchScore(Q, seq, extras){ const n=Q.length, levels=[], pos=[];
  for (const q of Q){ let best=0,bpos=-1; seq.forEach((t,j)=>{ const lv=level(q,t); if (lv>best){best=lv;bpos=j;} });
    for (const t of extras){ const lv=level(q,t); if (lv>best){best=lv;bpos=-1;} } levels.push(best); pos.push(bpos); }
  const pre = n<=seq.length && Q.slice(0,n-1).every((q,i)=>seq[i]===q) && seq[n-1].startsWith(Q[n-1]);
  const exact = n===seq.length && Q.every((q,i)=>seq[i]===q);
  const matched = new Set(pos.filter(p=>p>=0 && p<seq.length));
  let content = Q.map((q,i)=>i).filter(i=>!STOP.has(Q[i])); if (!content.length) content = Q.map((q,i)=>i);
  if (!content.some(i=>levels[i]>0)) return null;
  const nMiss = content.filter(i=>levels[i]===0).length;
  let s = 0; if (nMiss===0) s += W.m_all; s -= W.m_miss*nMiss; s -= W.m_fuzzy*levels.filter(l=>l===1).length;
  s += W.m_exact*levels.filter(l=>l===3).length/n; if (exact) s += W.m_core_exact; if (pre) s += W.m_prefix;
  s += W.m_coverage*matched.size/Math.max(1,seq.length); return s; }

let same=0, diff=0; const times=[]; const cache = new Map();
for (const c of D.queries) {
  const t0 = performance.now(); const Q = queryTokens(c.q); const scored=[];
  for (const id of c.cand) { const [names, P] = D.ents[id]; let v = cache.get(id);
    if (!v) { v=[]; names.forEach((nm,k)=>{ const [s,e]=nameTokens(nm); if (s.length || !v.length) v.push([s,e]); }); cache.set(id,v); }
    let best=null; for (const [s,e] of v){ const m=matchScore(Q,s,e); if (m!==null && (best===null || m>best)) best=m; }
    if (best!==null) scored.push([-(best+P), id]); }
  scored.sort((a,b)=> a[0]-b[0] || a[1]-b[1]); const top = scored.slice(0,10).map(x=>x[1]);
  times.push([performance.now()-t0, c.cand.length]);
  if (JSON.stringify(top)===JSON.stringify(c.top)) same++; else { diff++; if (diff<=5) console.log('DIFF', c.q, top.slice(0,3), c.top.slice(0,3)); }
}
times.sort((a,b)=>a[0]-b[0]);
console.log(`identical top-10: ${same}/${same+diff}; JS time per query (cold token cache) median ${times[times.length>>1][0].toFixed(1)}ms max ${times[times.length-1][0].toFixed(1)}ms (cands ${times[times.length-1][1]})`);
// warm re-run of the 10 heaviest (tokens cached): pure scoring cost per keystroke
const heavy = [...D.queries].sort((a,b)=>b.cand.length-a.cand.length).slice(0,10); const wt=[];
for (const c of heavy){ const t0=performance.now(); const Q=queryTokens(c.q); for (const id of c.cand){ for (const [s,e] of cache.get(id)) matchScore(Q,s,e);} wt.push([performance.now()-t0, c.cand.length]); }
console.log('warm scoring, 10 heaviest:', wt.map(x=>`${x[0].toFixed(0)}ms/${x[1]}`).join(' '));
