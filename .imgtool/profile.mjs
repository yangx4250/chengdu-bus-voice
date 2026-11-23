import fs from 'fs';
import jpeg from 'jpeg-js';
const img = jpeg.decode(fs.readFileSync('/data/user/0/com.dsharnessmobile.shell/files/home/.local/state/billion-context/retrieve/img/session-0c793835-7dd1-4d96-a1a7-f20152a8e1c9/m03903-70ac30dd.jpg'), { useTArray: true });
const { width: w, height: h, data } = img;
const lum = (i) => (data[i*4]*299+data[i*4+1]*587+data[i*4+2]*114)/1000;
console.log('y   minLum  cnt<236  cnt<200  first..last(<236)');
for (let y=0;y<h;y+=10) {
  let mn=999, c236=0, c200=0, f=-1, l=-1;
  for (let x=0;x<w;x++) { const i=y*w+x, v=lum(i); if(v<mn)mn=v;
    if (v<236){c236++; if(f<0)f=x; l=x;} if (v<200) c200++; }
  console.log(`${String(y).padStart(3)}  ${mn.toFixed(0).padStart(5)}  ${String(c236).padStart(6)}  ${String(c200).padStart(6)}  ${f}..${l}`);
}
