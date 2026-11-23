import fs from 'fs';
import jpeg from 'jpeg-js';
const img = jpeg.decode(fs.readFileSync('/data/user/0/com.dsharnessmobile.shell/files/home/.local/state/billion-context/retrieve/img/session-0c793835-7dd1-4d96-a1a7-f20152a8e1c9/m03903-70ac30dd.jpg'), { useTArray: true });
const { width: w, height: h, data } = img;
console.log(`size ${w}x${h}`);
const px = (x,y) => { const i=(y*w+x)*4; return [data[i],data[i+1],data[i+2]]; };
// 四角与边缘采样
for (const [x,y] of [[5,5],[60,5],[120,5],[5,60],[120,60],[400,5],[795,5],[5,400],[5,795],[400,400],[400,700],[400,120]]) {
  console.log(`(${x},${y}) = ${px(x,y).join(',')}`);
}
