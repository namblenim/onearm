const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const W = canvas.width, H = canvas.height;

// ----- Settings -----
const GRAVITY = 1000; // px/s^2 (use dt)
const DAMPING = 0.98;
const MAX_ARM = 240;
const PULL_FORCE = 900; // tuned for dt-based

// ----- Entities -----
const robot = { w:60,h:40,x:300,y:100,vx:0,vy:0,color:'#3b82f6',eye:'#bae6fd' };
const mouse = { x: W/2, y: H/2 };
const hand = { x: mouse.x, y: mouse.y };
let prevHand = { x: mouse.x, y: mouse.y };
let handVx = 0, handVy = 0;

let isGrabbing = false, grabType = null, grabbed = null;
let holdTimer = 0;

const platforms = [ {x:-200,y:620,w:2000,h:200}, {x:60,y:470,w:160,h:140}, {x:880,y:420,w:260,h:200} ];
const phys = [ {id:1,type:'circle',r:18,x:120,y:400,vx:0,vy:0,color:'#f59e0b'}, {id:2,type:'rect',w:35,h:35,x:500,y:550,vx:0,vy:0,color:'#10b981'}, {id:3,type:'rect',w:100,h:100,x:950,y:250,vx:0,vy:0,color:'#ef4444'} ];

// Input
canvas.addEventListener('mousemove', e=>{ const r=canvas.getBoundingClientRect(); const sx=W/r.width, sy=H/r.height; mouse.x=(e.clientX-r.left)*sx; mouse.y=(e.clientY-r.top)*sy; });
let mouseDown = false;
canvas.addEventListener('mousedown', e=>{ if(e.button===0){ mouseDown=true; holdTimer=0; } });
canvas.addEventListener('mouseup', e=>{ if(e.button===0){ mouseDown=false; if(isGrabbing && grabType==='object' && grabbed){ const MAX_THROW=120; let tvx = Math.max(-MAX_THROW,Math.min(MAX_THROW,handVx)); let tvy = Math.max(-MAX_THROW,Math.min(MAX_THROW,handVy)); grabbed.vx = tvx; grabbed.vy = tvy; } isGrabbing=false; grabType=null; grabbed=null; } });

function checkGrab(hx,hy){ const TOL=26; for(let o of phys){ if(o.type==='circle'){ let dx=hx-o.x, dy=hy-o.y; if(dx*dx+dy*dy < (o.r+TOL)*(o.r+TOL)) return {can:true,type:'object',target:o,x:o.x,y:o.y}; } else { if(hx > o.x-TOL && hx < o.x+o.w+TOL && hy > o.y-TOL && hy < o.y+o.h+TOL) return {can:true,type:'object',target:o,x:o.x+o.w/2,y:o.y+o.h/2}; } }
  for(let p of platforms){ let cx = Math.max(p.x, Math.min(hx, p.x+p.w)); let cy = Math.max(p.y, Math.min(hy, p.y+p.h)); let dx=hx-cx, dy=hy-cy; if(dx*dx+dy*dy < TOL*TOL) return {can:true,type:'platform',x:cx,y:cy}; }
  return {can:false}; }

function getElbow(p1,p2,L){ let dx=p2.x-p1.x, dy=p2.y-p1.y; let d=Math.hypot(dx,dy); if(d<0.0001) return {x:p1.x+dx*0.5,y:p1.y+dy*0.5}; if(d>=L) return {x:p1.x+(dx/d)*(L/2),y:p1.y+(dy/d)*(L/2)}; let l1=L/2,a=d/2,h=Math.sqrt(Math.max(0,l1*l1-a*a)); let cx=p1.x+dx/2, cy=p1.y+dy/2; return {x:cx + h*(dy/d), y:cy - h*(dx/d)} }

// timing
let last = performance.now();
function loop(ts){ let dt=(ts-last)/1000; if(dt>0.05) dt=0.05; last=ts; update(dt); draw(); requestAnimationFrame(loop); }

function update(dt){ // target hand
  const centerX = robot.x + robot.w/2; const shoulderY = robot.y + 10;
  let tx = mouse.x, ty = mouse.y;

  // limit arm length
  let dx = tx-centerX, dy = ty-shoulderY, dist = Math.hypot(dx,dy);
  if(dist > MAX_ARM){ tx = centerX + dx/dist*MAX_ARM; ty = shoulderY + dy/dist*MAX_ARM; }

  // platform push-out
  for(let p of platforms){ if(tx>p.x && tx<p.x+p.w && ty>p.y && ty<p.y+p.h){ let dl=tx-p.x, dr=(p.x+p.w)-tx, dtp=ty-p.y, db=(p.y+p.h)-ty; let m=Math.min(dl,dr,dtp,db); if(m===dtp) ty=p.y; else if(m===db) ty=p.y+p.h; else if(m===dl) tx=p.x; else tx=p.x+p.w; } }

  hand.x = tx; hand.y = ty;
  handVx = (hand.x - prevHand.x)/dt; handVy = (hand.y - prevHand.y)/dt; prevHand.x = hand.x; prevHand.y = hand.y;

  // grabbing intent: require short hold to avoid accidental grabs
  const sug = checkGrab(hand.x,hand.y);
  if(mouseDown){ holdTimer += dt*1000; if(!isGrabbing && sug.can && holdTimer > 100){ isGrabbing=true; grabType=sug.type; if(grabType==='object') grabbed=sug.target; } }
  else { holdTimer=0; }

  // apply grab effects
  if(isGrabbing && grabType==='platform'){ let px = hand.x - centerX, py = hand.y - shoulderY; robot.vx += (px)*dt* (PULL_FORCE/200); let pullY = (py)*dt*(PULL_FORCE/400); if(py<0) pullY*=1.2; robot.vy += pullY; }

  // physics robot
  robot.vy += GRAVITY*dt; robot.x += robot.vx*dt; robot.y += robot.vy*dt; robot.vx *= Math.pow(DAMPING, dt*60); robot.vy *= Math.pow(DAMPING, dt*60);

  // collisions with platforms (simple AABB)
  let onGround=false;
  for(let p of platforms){ if(robot.x < p.x+p.w && robot.x+robot.w > p.x && robot.y < p.y+p.h && robot.y+robot.h > p.y){ let ol=(robot.x+robot.w)-p.x, or=(p.x+p.w)-robot.x, ot=(robot.y+robot.h)-p.y, ob=(p.y+p.h)-robot.y; let m=Math.min(ol,or,ot,ob); if(m===ot){ robot.y = p.y - robot.h; robot.vy = 0; onGround=true; } else if(m===ob){ robot.y = p.y + p.h; robot.vy = 0; } else if(m===ol){ robot.x = p.x - robot.w; robot.vx = 0; } else { robot.x = p.x + p.w; robot.vx = 0; } } }

  // objects
  for(let o of phys){ if(isGrabbing && grabType==='object' && grabbed===o){ if(o.type==='circle'){ o.x = hand.x; o.y = hand.y; } else { o.x = hand.x - o.w/2; o.y = hand.y - o.h/2; } o.vx = 0; o.vy = 0; continue; }
    o.vy += GRAVITY*dt; o.x += o.vx*dt; o.y += o.vy*dt; o.vx *= Math.pow(0.95, dt*60);
    // simple ground
    for(let p of platforms){ if(o.type==='circle'){ if(o.x>p.x && o.x<p.x+p.w && o.y+o.r > p.y && o.y-o.r < p.y+p.h){ o.y = p.y - o.r; o.vy *= -0.2; o.vx *= 0.8; } } else { if(o.x < p.x+p.w && o.x+o.w > p.x && o.y < p.y+p.h && o.y+o.h > p.y){ let ol=(o.x+o.w)-p.x, or=(p.x+p.w)-o.x, ot=(o.y+o.h)-p.y, ob=(p.y+p.h)-o.y; let m=Math.min(ol,or,ot,ob); if(m===ot){ o.y = p.y - o.h; o.vy *= -0.2; o.vx *= 0.8; } else if(m===ob){ o.y = p.y + p.h; o.vy = 0; } else if(m===ol){ o.x = p.x - o.w; o.vx = 0; } else { o.x = p.x + p.w; o.vx = 0; } } } 
    if(o.y > H + 500){ o.y = 100; o.x = 600; o.vy = 0; }
  }

  if(robot.y > H + 300){ robot.x = 300; robot.y = 100; robot.vx = 0; robot.vy = 0; }
}

function draw(){ ctx.clearRect(0,0,W,H);
  // platforms
  for(let p of platforms){ ctx.fillStyle='#d6c898'; ctx.fillRect(p.x,p.y,p.w,p.h); ctx.strokeStyle='#8e7c48'; ctx.lineWidth=3; ctx.strokeRect(p.x,p.y,p.w,p.h); }
  // objects
  for(let o of phys){ ctx.fillStyle=o.color; ctx.strokeStyle='#2d3748'; ctx.lineWidth=3; if(o.type==='circle'){ ctx.beginPath(); ctx.arc(o.x,o.y,o.r,0,Math.PI*2); ctx.fill(); ctx.stroke(); } else { ctx.fillRect(o.x,o.y,o.w,o.h); ctx.strokeRect(o.x,o.y,o.w,o.h); } }
  // arm
  const cx = robot.x + robot.w/2; const shoulderY = robot.y + 10; const elbow = getElbow({x:cx,y:shoulderY},hand,MAX_ARM);
  ctx.strokeStyle='#94a3b8'; ctx.lineWidth=9; ctx.lineJoin='round'; ctx.beginPath(); ctx.moveTo(cx,shoulderY); ctx.lineTo(elbow.x,elbow.y); ctx.lineTo(hand.x,hand.y); ctx.stroke();
  // hand
  ctx.save(); ctx.translate(hand.x,hand.y); let ang = Math.atan2(hand.y-elbow.y,hand.x-elbow.x); ctx.rotate(ang);
  ctx.fillStyle = (isGrabbing? '#34d399' : '#94a3b8'); ctx.fillRect(-6,-10,16,20); ctx.restore();
  // robot body
  ctx.fillStyle = '#0f1724'; ctx.fillRect(robot.x+4,robot.y+22,robot.w-8,18); ctx.fillStyle = robot.color; roundRect(ctx, robot.x, robot.y, robot.w, 30, 8); ctx.fill();
  // head
  ctx.fillStyle='#0f1724'; ctx.beginPath(); ctx.arc(cx, robot.y-10, 20,0,Math.PI*2); ctx.fill(); ctx.fillStyle=robot.eye; ctx.beginPath(); ctx.arc(cx + Math.cos(Math.atan2(mouse.y-(robot.y-10), mouse.x-cx))*8, robot.y-10 + Math.sin(Math.atan2(mouse.y-(robot.y-10), mouse.x-cx))*8, 8,0,Math.PI*2); ctx.fill();
}

function roundRect(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

requestAnimationFrame(loop);
