import fs from 'fs';
import jpeg from 'jpeg-js';
const img = jpeg.decode(fs.readFileSync('/data/user/0/com.dsharnessmobile.shell/files/home/.local/state/billion-context/retrieve/img/session-0c793835-7dd1-4d96-a1a7-f20152a8e1c9/m03903-70ac30dd.jpg'), { useTArray: true });
const { width: w, height: h, data } = img;
const N = 64; // 64x64 grid
const cw = w/N, ch = h/N;
let out = '';
for (let gy=0; gy<N; gy++) {
  let line = '';
  for (let gx=0; gx<N; gx++) {
    let r=0,g=0,b=0,c=0;
    for (let y=Math.floor(gy*ch); y<Math.floor((gy+1)*ch); y++)
      for (let x=Math.floor(gx*cw); x<Math.floor((gx+1)*cw); x++) {
        const i=(y*w+x)*4; r+=data[i]; g+=data[i+1]; b+=data[i+2]; c++;
      }
    r/=c; g/=c; b/=c;
    const lum = (r*299+g*587+b*114)/1000;
    const sat = Math.max(r,g,b) - Math.min(r,g,b);
    let chr;
    if (sat > 40) chr = '#';
    else if (lum < 120) chr = '@';
    else if (lum < 180) chr = '+';
    else if (lum < 215) chr = '-';
    else if (lum < 240) chr = '.';
    else chr = ' ';
    line += chr;
  }
  out += line + '\n';
}
console.log(out);
