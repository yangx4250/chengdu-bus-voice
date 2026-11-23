import fs from 'fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const SRC = '/data/user/0/com.dsharnessmobile.shell/files/home/.local/state/billion-context/retrieve/img/session-0c793835-7dd1-4d96-a1a7-f20152a8e1c9/m03903-70ac30dd.jpg';
const img = jpeg.decode(fs.readFileSync(SRC), { useTArray: true });
const { width: W, height: H, data } = img;

// 拟合得到的圆角方形几何（见 probe6/detect 拟合：L=33 T=23 R=116 S=736）
const L = 33, T = 23, S = 736;
const RADIUS_RATIO = 116 / 736;

function sample(sx, sy) {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(sx)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(sy)));
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
  const P = (xx, yy) => { const i = (yy * W + xx) * 4; return [data[i], data[i+1], data[i+2]]; };
  const c00 = P(x0,y0), c10 = P(x1,y0), c01 = P(x0,y1), c11 = P(x1,y1);
  return [0,1,2].map(k => (c00[k]*(1-fx)+c10[k]*fx)*(1-fy) + (c01[k]*(1-fx)+c11[k]*fx)*fy);
}

function render(size, outPath) {
  const png = new PNG({ width: size, height: size });
  const r = size * RADIUS_RATIO;
  const half = size / 2;
  const inset = half - r;
  const scale = S / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      // 圆角矩形 SDF
      const px = x + 0.5, py = y + 0.5;
      const dx = Math.max(0, Math.abs(px - half) - inset);
      const dy = Math.max(0, Math.abs(py - half) - inset);
      const sd = Math.sqrt(dx*dx + dy*dy) - r;
      const alpha = Math.max(0, Math.min(1, 0.5 - sd));
      if (alpha <= 0) { png.data[o+3] = 0; continue; }
      const c = sample(L + px * scale, T + py * scale);
      png.data[o]   = Math.round(c[0]);
      png.data[o+1] = Math.round(c[1]);
      png.data[o+2] = Math.round(c[2]);
      png.data[o+3] = Math.round(255 * alpha);
    }
  }
  fs.writeFileSync(outPath, PNG.sync.write(png));
  return png;
}

// 预览
render(512, 'preview_new512.png');

// 五档密度写入 res
const RES = '../app/res';
for (const [dir, size] of [['drawable-mdpi',48],['drawable-hdpi',72],['drawable-xhdpi',96],['drawable-xxhdpi',144],['drawable-xxxhdpi',192]]) {
  fs.mkdirSync(`${RES}/${dir}`, { recursive: true });
  render(size, `${RES}/${dir}/ic_launcher.png`);
  console.log(`${dir}/ic_launcher.png ${size}x${size}`);
}

// 数值校验
const p = render(512, '/tmp/_verify.png');
const d = p.data;
let transparent = 0, opaque = 0, semi = 0;
let cl=512, cr=-1, ct=512, cb=-1;
for (let y=0;y<512;y++) for (let x=0;x<512;x++) {
  const a = d[(y*512+x)*4+3];
  if (a === 0) transparent++;
  else if (a === 255) { opaque++; if(x<cl)cl=x; if(x>cr)cr=x; if(y<ct)ct=y; if(y>cb)cb=y; }
  else semi++;
}
console.log(`alpha: 全透明=${transparent} 半透明=${semi} 不透明=${opaque}`);
console.log(`不透明区 bbox ${cl},${ct}..${cr},${cb}`);
for (const [x,y] of [[0,0],[511,0],[0,511],[511,511],[256,256]]) {
  const o=(y*512+x)*4;
  console.log(`(${x},${y}) rgba=${d[o]},${d[o+1]},${d[o+2]},${d[o+3]}`);
}
