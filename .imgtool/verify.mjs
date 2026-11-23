import fs from 'fs';
import { PNG } from 'pngjs';
const png = PNG.sync.read(fs.readFileSync('preview_new512.png'));
const d = png.data, size = 512;
let transparent = 0, opaque = 0, semi = 0;
let cl=size, cr=-1, ct=size, cb=-1;
for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
  const a = d[(y*size+x)*4+3];
  if (a === 0) transparent++;
  else if (a === 255) { opaque++; if(x<cl)cl=x; if(x>cr)cr=x; if(y<ct)ct=y; if(y>cb)cb=y; }
  else semi++;
}
console.log(`alpha: 全透明=${transparent} 半透明=${semi} 不透明=${opaque}`);
console.log(`不透明区 bbox ${cl},${ct}..${cr},${cb}`);
for (const [x,y] of [[0,0],[511,0],[0,511],[511,511],[256,256],[3,3]]) {
  const o=(y*size+x)*4;
  console.log(`(${x},${y}) rgba=${d[o]},${d[o+1]},${d[o+2]},${d[o+3]}`);
}
