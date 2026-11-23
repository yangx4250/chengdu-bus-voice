import fs from 'fs';
import jpeg from 'jpeg-js';
const img = jpeg.decode(fs.readFileSync('/data/user/0/com.dsharnessmobile.shell/files/home/.local/state/billion-context/retrieve/img/session-0c793835-7dd1-4d96-a1a7-f20152a8e1c9/m03903-70ac30dd.jpg'), { useTArray: true });
const { width: w, height: h, data } = img;
const px = (x,y) => { const i=(y*w+x)*4; return [data[i],data[i+1],data[i+2]]; };
const isBg = (c) => c[0]>=228 && c[1]>=228 && c[2]>=228;
// 行剖面：每 20 行统计非背景像素的起止
console.log('--- ROW PROFILE (every 20 rows): row  first..last  count');
for (let y=0;y<h;y+=20) {
  let f=-1,l=-1,c=0;
  for (let x=0;x<w;x++) if (!isBg(px(x,y))) { if(f<0)f=x; l=x; c++; }
  console.log(`y=${String(y).padStart(3)}  ${String(f).padStart(4)}..${String(l).padStart(4)}  ${c}`);
}
