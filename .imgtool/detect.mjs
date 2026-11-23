import fs from 'fs';
import jpeg from 'jpeg-js';
const img = jpeg.decode(fs.readFileSync('/data/user/0/com.dsharnessmobile.shell/files/home/.local/state/billion-context/retrieve/img/session-0c793835-7dd1-4d96-a1a7-f20152a8e1c9/m03903-70ac30dd.jpg'), { useTArray: true });
const { width: w, height: h, data } = img;
const lum = (i) => (data[i*4]*299+data[i*4+1]*587+data[i*4+2]*114)/1000;

const TH = 238;
// 从中心做连通域（4 邻域），得到图标主体掩码
const mask = new Uint8Array(w*h);
const seen = new Uint8Array(w*h);
const stack = [(400*w+400)];
seen[400*w+400] = 1;
while (stack.length) {
  const i = stack.pop();
  mask[i] = 1;
  const x = i % w, y = (i/w)|0;
  for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = x+dx, ny = y+dy;
    if (nx<0||ny<0||nx>=w||ny>=h) continue;
    const ni = ny*w+nx;
    if (seen[ni]) continue;
    if (lum(ni) < TH) { seen[ni]=1; stack.push(ni); }
  }
}
let left=w,right=-1,top=h,bot=-1,cnt=0;
for (let i=0;i<w*h;i++) if (mask[i]) { cnt++; const x=i%w,y=(i/w)|0;
  if(x<left)left=x; if(x>right)right=x; if(y<top)top=y; if(y>bot)bot=y; }
console.log(`CC bbox ${left},${top}..${right},${bot}  ${right-left+1}x${bot-top+1}  px=${cnt}`);
// 圆角半径：顶部边缘在 x=中心 处的 y，与最左侧 x 处的 y 比较
let midX = ((left+right)/2)|0;
let topAtMid = -1;
for (let y=top;y<=bot;y++) if (mask[y*w+midX]) { topAtMid=y; break; }
let midY = ((top+bot)/2)|0;
let leftAtMid = -1;
for (let x=left;x<=right;x++) if (mask[midY*w+x]) { leftAtMid=x; break; }
console.log(`topAtMid=${topAtMid} leftAtMid=${leftAtMid}`);
// 逐行找左边界，用于拟合圆角
console.log('--- top-left corner profile (y, firstX)');
for (let y=top; y<top+80; y+=4) {
  let f=-1;
  for (let x=left;x<=right;x++) if (mask[y*w+x]) { f=x; break; }
  console.log(`  y=${y} x=${f}`);
}
fs.writeFileSync('mask.bin', Buffer.from(mask));
fs.writeFileSync('bbox.json', JSON.stringify({left,right,top,bot,w,h}));
