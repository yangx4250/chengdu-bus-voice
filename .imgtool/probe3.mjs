import fs from 'fs';
import jpeg from 'jpeg-js';
const img = jpeg.decode(fs.readFileSync('/data/user/0/com.dsharnessmobile.shell/files/home/.local/state/billion-context/retrieve/img/session-0c793835-7dd1-4d96-a1a7-f20152a8e1c9/m03903-70ac30dd.jpg'), { useTArray: true });
const { width: w, height: h, data } = img;
const px = (x,y) => { const i=(y*w+x)*4; return [data[i],data[i+1],data[i+2]]; };
// 背景近白：三通道都 >= 230。找非背景 bbox
let left=w,right=-1,top=h,bot=-1, cnt=0;
for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
  const c = px(x,y);
  const isBg = c[0]>=228 && c[1]>=228 && c[2]>=228;
  if (!isBg) { cnt++; if(x<left)left=x; if(x>right)right=x; if(y<top)top=y; if(y>bot)bot=y; }
}
console.log(`non-bg bbox ${left},${top}..${right},${bot}  ${right-left+1}x${bot-top+1}  count=${cnt} (${(cnt/(w*h)*100).toFixed(1)}%)`);
// 中线剖面：第 400 行从 0..800 每 40 像素
for (let x=0;x<=800;x+=40) { const c=px(Math.min(x,799),400); console.log(`row400 x=${x}: ${c.join(',')}`); }
