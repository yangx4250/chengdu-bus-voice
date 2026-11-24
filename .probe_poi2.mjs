import crypto from 'node:crypto';
const BASE='https://web.chelaile.net.cn/api/bus/',SALT='qwihrnbtmj',KEY=Buffer.from('FF32AE65FBFD19414EAAFF6291A54B42','utf8');
const H={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254160a) XWEB/18055','xweb_xhr':'1','Content-Type':'text','Accept':'*/*','Referer':'https://servicewechat.com/wx71d589ea01ce3321/814/page-frame.html','Accept-Language':'zh-CN,zh;q=0.9'};
const BP={s:'h5',wxs:'wx_app',sign:'1',h5RealData:'1',v:'3.11.28',src:'weixinapp_cx',ctm_mp:'mp_wx',vc:'2',favoriteGray:'1',gpstype:'wgs',geo_type:'wgs',scene:'1256'};
function sign(p){return crypto.createHash('md5').update(Object.entries(p).map(([k,v])=>`"${k}"="${v}"`).join('&')+SALT,'utf8').digest('hex');}
function env(raw){const s=raw.indexOf('{');if(s<0)return null;let d=0;for(let i=s;i<raw.length;i++){if(raw[i]==='{')d++;else if(raw[i]==='}'){d--;if(d===0)return JSON.parse(raw.slice(s,i+1));}}return null;}
function dec(s){const c=crypto.createDecipheriv('aes-256-ecb',KEY,Buffer.alloc(0));return JSON.parse(Buffer.concat([c.update(Buffer.from(s,'base64')),c.final()]).toString('utf8'));}
async function search(kw,extra){const q={...BP,cityId:'007',localCityId:'007',key:kw,...(extra||{})};q.cryptoSign=sign(q);
  const url=`${BASE}query!nSearch.action?${new URLSearchParams(q)}`;
  try{const r=await fetch(url,{headers:H,signal:AbortSignal.timeout(10000)});const t=await r.text();const j=env(t);if(!j)return {err:'no json '+t.slice(0,80)};
    const d=j.encryptResult?dec(j.encryptResult):j;const res=d.result||d;
    return {topKeys:Object.keys(d),resKeys:Object.keys(res),pois:res.pois,poiCount:res.poiCount,stations:(res.stations||[]).length,staCount:res.stationCount};
  }catch(e){return {err:e.message};}
}
const r=await search('春熙路');
console.log('top',JSON.stringify(r.topKeys||r.err));
console.log('res',JSON.stringify(r.resKeys));
console.log('poiCount',r.poiCount,'staCount',r.staCount,'stations',r.stations);
console.log('pois raw',JSON.stringify(r.pois).slice(0,2000));
