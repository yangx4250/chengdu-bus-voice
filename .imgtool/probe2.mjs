import fs from 'fs';
import jpeg from 'jpeg-js';
const img = jpeg.decode(fs.readFileSync('/data/user/0/com.dsharnessmobile.shell/files/home/.local/state/billion-context/retrieve/img/session-0c793835-7dd1-4d96-a1a7-f20152a8e1c9/m03903-70ac30dd.jpg'), { useTArray: true });
const { width: w, height: h, data } = img;
const px = (x,y) => { const i=(y*w+x)*4; return [data[i],data[i+1],data[i+2]]; };
// 棋盘格透明区 vs 白色立体图标的区分：找边缘过渡。扫描第 400 行与第 5 行的完整色值分布
// 检查角落是否有棋盘格灰白交替
let samples = [];
for (let x=0; x<200; x+=1) samples.push(px(x,3));
// 统计第3行前200像素的唯一色
const uniq = new Map();
for (const c of samples) { const k = c.join(','); uniq.set(k, (uniq.get(k)||0)+1); }
console.log('row3 first200 unique colors:', [...uniq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8));
// 第 200 行
samples = [];
for (let x=0; x<200; x+=1) samples.push(px(x,200));
const uniq2 = new Map();
for (const c of samples) { const k = c.join(','); uniq2.set(k, (uniq2.get(k)||0)+1); }
console.log('row200 first200 unique:', [...uniq2.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8));
// col3 前 200
samples = [];
for (let y=0; y<200; y+=1) samples.push(px(3,y));
const uniq3 = new Map();
for (const c of samples) { const k = c.join(','); uniq3.set(k, (uniq3.get(k)||0)+1); }
console.log('col3 first200 unique:', [...uniq3.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8));
