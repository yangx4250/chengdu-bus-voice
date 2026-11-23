import fs from 'fs';
import jpeg from 'jpeg-js';
const SRC='/data/user/0/com.dsharnessmobile.shell/files/home/.local/state/billion-context/retrieve/img/session-0c793835-7dd1-4d96-a1a7-f20152a8e1c9/m03903-70ac30dd.jpg';
const img = jpeg.decode(fs.readFileSync(SRC), { useTArray: true });
const { width: w, height: h, data } = img;
const C = (i) => [data[i*4], data[i*4+1], data[i*4+2]];
const L = (i) => { const c=C(i); return (c[0]*299+c[1]*587+c[2]*114)/1000; };

// 1) 从四角洪水填充背景（邻居容差 12）
const bg = new Uint8Array(w*h);
const st = [];
const seed = (x,y) => { const i=y*w+x; if(!bg[i]){bg[i]=1;st.push(i);} };
for (const [x,y] of [[0,0],[w-1,0],[0,h-1],[w-1,h-1]]) seed(x,y);
const TOL = 12;
while (st.length) {
  const i = st.pop();
  const x = i % w, y = (i/w)|0;
  const c = C(i);
  for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx=x+dx, ny=y+dy;
    if (nx<0||ny<0||nx>=w||ny>=h) continue;
    const ni = ny*w+nx;
    if (bg[ni]) continue;
    const d = C(ni);
    if (Math.abs(d[0]-c[0])<=TOL && Math.abs(d[1]-c[1])<=TOL && Math.abs(d[2]-c[2])<=TOL) { bg[ni]=1; st.push(ni); }
  }
}
let nbg=0; for (let i=0;i<w*h;i++) if(!bg[i]) nbg++;
console.log(`背景填充后 非背景像素 ${nbg} (${(nbg/(w*h)*100).toFixed(1)}%)`);

// 2) 主体 = 非背景 且 亮度 >= 205（排除深色投影）
const body = new Uint8Array(w*h);
let l=w,r=-1,t=h,b=-1;
for (let i=0;i<w*h;i++) {
  if (bg[i]) continue;
  if (L(i) < 205) continue;
  body[i]=1;
  const x=i%w, y=(i/w)|0;
  if(x<l)l=x; if(x>r)r=x; if(y<t)t=y; if(y>b)b=y;
}
console.log(`主体 bbox ${l},${t}..${r},${b}  ${r-l+1}x${b-t+1}`);

// 3) 逐行 extent，看圆角与底部
console.log('--- 逐行主体范围（每 10 行）');
for (let y=t;y<=b;y+=10) {
  let f=-1,la=-1;
  for (let x=l;x<=r;x++) if (body[y*w+x]) { if(f<0)f=x; la=x; }
  console.log(`  y=${String(y).padStart(3)}  ${String(f).padStart(4)}..${String(la).padStart(4)}`);
}
fs.writeFileSync('body.bin', Buffer.from(body));
fs.writeFileSync('det.json', JSON.stringify({l,t,r,b,w,h}));
