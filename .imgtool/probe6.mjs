import fs from 'fs';
import jpeg from 'jpeg-js';
const img = jpeg.decode(fs.readFileSync('/data/user/0/com.dsharnessmobile.shell/files/home/.local/state/billion-context/retrieve/img/session-0c793835-7dd1-4d96-a1a7-f20152a8e1c9/m03903-70ac30dd.jpg'), { useTArray: true });
const { width: w, height: h, data } = img;
const lum = (x,y) => { const i=(y*w+x)*4; return (data[i]*299+data[i+1]*587+data[i+2]*114)/1000; };
const TH = 236;
let left=w,right=-1,top=h,bot=-1;
for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
  if (lum(x,y) < TH) { if(x<left)left=x; if(x>right)right=x; if(y<top)top=y; if(y>bot)bot=y; }
}
console.log(`TH=${TH} bbox ${left},${top}..${right},${bot}  ${right-left+1}x${bot-top+1}`);
// 角上取圆角半径：找第一行非背景的 x 范围随 y 变化
console.log('--- top rows: y  first..last');
for (let y=top; y<top+90; y+=6) {
  let f=-1,l=-1;
  for (let x=0;x<w;x++) if (lum(x,y)<TH) { if(f<0)f=x; l=x; }
  console.log(`  y=${y}  ${f}..${l}`);
}
