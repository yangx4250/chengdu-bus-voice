package com.chengdu.bus;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Set;

/**
 * 西昌公交（熊猫巴士 PandaBus 白牌站）数据源。
 *
 * <p>来源：逆向 月城公交 App (com.pandabus.android.yuecheng) 2.7.5，服务端址见
 * {@code com.pandabus.android.yuecheng.common.Dictionarys}。</p>
 *
 * <p><b>能用什么</b>：{@code /search} 换乘规划 —— 不用 token、不用签名，纯 GET。
 * 返回线路全名（含起终点）、首末班、票价、途经站、轨迹点。实测 2026-11-27 可用。</p>
 *
 * <p><b>不能用什么</b>：实时到站（还有几站/几分钟）。App 的业务实现被爱加密抽走、
 * 静态逆不出来；HTTP 抓包也只看到启动类请求，实时数据不在 {@code :8800} 的 REST 里。
 * 所以本类<b>只做换乘</b>，附近站点/线路详情/到站一律如实返回「暂无」，
 * 不要编造空数据让界面显示成「这条线没车」。</p>
 *
 * <p><b>务必限速</b>：该站前面有阿里云 WAF，频繁请求会返回 405 HTML
 * （「访问有可能对网站造成安全威胁」），是 IP 级限制，换 UA/Referer 无效。
 * 所以每次换乘查询之间至少间隔 1.5 秒，并且结果要缓存。</p>
 */
public final class XichangClient {

    /** cityId 前缀，和车来了数字 id、掌上公交 mg- 都不冲突。 */
    public static final String PREFIX = "xc-";
    public static final String CITY_ID = "xc-xichang";
    public static final String CITY_NAME = "西昌";

    private static final String HOST = "https://www.xcycgj.cn:7777";
    private static final String CITY_CODE = "xc";
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13; 2211133C) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/120.0.0.0 Mobile Safari/537.36";

    /** WAF 拦截（405 HTML 页）。调用方据此提示「稍后再试」，而不是「没有数据」。 */
    public static class WafBlockedException extends Exception {
        public WafBlockedException() { super("西昌服务器临时限制访问，请稍后再试"); }
    }

    public static boolean isMine(String cityId) {
        return cityId != null && cityId.trim().startsWith(PREFIX);
    }

    /** 城市表条目（给前端城市选择器）。 */
    public static JSONArray cityTable() {
        JSONArray out = new JSONArray();
        try {
            JSONObject item = new JSONObject();
            item.put("cityId", CITY_ID);
            item.put("name", CITY_NAME);
            item.put("group", "凉山");
            item.put("level", "city");
            item.put("source", "xichang");
            /* 前端据此提示「这个城市只有换乘规划，没有实时到站」 */
            item.put("transitOnly", true);
            out.put(item);
        } catch (Exception ignored) {
        }
        return out;
    }

    private final String cityId;

    public XichangClient(String cityId) {
        this.cityId = cityId == null || cityId.trim().isEmpty() ? CITY_ID : cityId;
    }

    public String cityId() { return cityId; }
    public String cityName() { return CITY_NAME; }

    private JSONObject get(String path) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(HOST + path).openConnection();
        try {
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(18000);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Accept", "application/json, text/plain, */*");
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in == null) throw new java.io.IOException("HTTP " + code);
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            in.close();
            String text = new String(buf.toByteArray(), StandardCharsets.UTF_8).trim();
            /* WAF 返回 HTML 拦截页，正常接口返回 JSON */
            if (!text.startsWith("{")) throw new WafBlockedException();
            if (code >= 400) throw new java.io.IOException("西昌接口返回 HTTP " + code);
            return new JSONObject(text);
        } finally {
            conn.disconnect();
        }
    }

    /**
     * 换乘规划。输出严格对齐 {@link ChelaileClient#transit}：
     * { transits:[{ duration, walkingDistance, transferCount, tag,
     *               segments:[{ mode, name, lineId, from, to, viaNum, duration, walkDistance }] }] }
     *
     * @param strategy 西昌接口不支持策略，忽略
     */
    public JSONObject transit(double fromLat, double fromLng, String fromName,
                              double destLat, double destLng, String destName,
                              String strategy) throws Exception {
        /* 实测直接用 WGS84 坐标就能返回正确结果（和车来了的 GCJ-02 要求不同），
           所以这里不做坐标转换 —— 转了反而会偏。 */
        String q = "/search?cityCode=" + CITY_CODE
                + "&startLat=" + fromLat + "&startLng=" + fromLng
                + "&endLat=" + destLat + "&endLng=" + destLng;
        JSONObject data = get(q);
        JSONArray routes = data.optJSONArray("result");
        JSONArray out = new JSONArray();
        if (routes == null) {
            JSONObject empty = new JSONObject();
            empty.put("transits", out);
            return empty;
        }
        for (int i = 0; i < routes.length(); i++) {
            JSONObject r = routes.optJSONObject(i);
            if (r == null) continue;
            JSONObject plan = new JSONObject();
            /* duration / distance 单位是秒 / 米 */
            plan.put("duration", Math.round(r.optDouble("duration", 0) / 60.0));
            plan.put("walkingDistance", Math.round(r.optDouble("walkDistance", 0)));
            plan.put("tag", "");
            plan.put("price", r.optString("totalTicketPrice", ""));
            plan.put("stopCount", r.optInt("stopCount", 0));

            JSONArray segsOut = new JSONArray();
            JSONArray segs = r.optJSONArray("segments");
            int busCount = 0;
            if (segs != null) {
                for (int s = 0; s < segs.length(); s++) {
                    JSONObject seg = segs.optJSONObject(s);
                    if (seg == null) continue;
                    JSONObject bus = seg.optJSONObject("bus");
                    if (bus != null) {
                        busCount++;
                        JSONObject rs = new JSONObject();
                        rs.put("mode", "bus");
                        /* routeName 形如「3路上行(63790部队-武警州支队二大队)」，
                           拆出纯线路名和起终点，界面才好看 */
                        String full = bus.optString("routeName", "");
                        rs.put("name", shortLineName(full));
                        rs.put("rawName", full);
                        rs.put("lineId", bus.optString("routeId", ""));
                        rs.put("from", stopName(bus.optJSONObject("departStop")));
                        rs.put("to", stopName(bus.optJSONObject("arriveStop")));
                        JSONArray via = bus.optJSONArray("viaStops");
                        rs.put("viaNum", via == null ? 0 : via.length());
                        rs.put("duration", Math.round(bus.optDouble("duration", 0) / 60.0));
                        rs.put("firstTime", bus.optString("startTime", ""));
                        rs.put("lastTime", bus.optString("endTime", ""));
                        rs.put("price", bus.optString("ticketPrice", ""));
                        segsOut.put(rs);
                    } else {
                        JSONObject walking = seg.optJSONObject("walking");
                        if (walking != null) {
                            int wd = (int) Math.round(walking.optDouble("distance", 0));
                            if (wd > 0) {
                                JSONObject ws = new JSONObject();
                                ws.put("mode", "walk");
                                ws.put("walkDistance", wd);
                                ws.put("duration", Math.round(walking.optDouble("duration", 0) / 60.0));
                                segsOut.put(ws);
                            }
                        }
                    }
                }
            }
            plan.put("transferCount", Math.max(0, busCount - 1));
            plan.put("segments", segsOut);
            out.put(plan);
        }
        JSONObject result = new JSONObject();
        result.put("transits", out);
        return result;
    }

    /** 「3路上行(63790部队-武警州支队二大队)」→「3路」 */
    private static String shortLineName(String full) {
        if (full == null || full.isEmpty()) return "";
        int cut = full.indexOf('(');
        String head = cut > 0 ? full.substring(0, cut) : full;
        /* 去掉「上行 / 下行」后缀 */
        return head.replace("上行", "").replace("下行", "").trim();
    }

    private static String stopName(JSONObject stop) {
        return stop == null ? "" : stop.optString("name", "");
    }

    // ---------------------------------------------------------- 实时到站

    /**
     * 实时数据服务器：<b>裸 TCP，明文协议</b>。
     *
     * <p>这就是之前一直抓不到实时数据的原因 —— 它不走 HTTP(S)，
     * 所以抓包工具（ProxyPin / Charles）默认只能看到 App 启动时的那几个
     * {@code :8800} 请求，看不到车辆数据。用 tcpdump 或 TCP 层重定向才能看到。</p>
     */
    private static final String RT_HOST = "39.108.28.78";
    private static final int RT_PORT = 1787;
    /** 帧头魔数。 */
    private static final int RT_MAGIC = 0x0000babe;
    /** 每条车辆记录的字段数，协议固定 24 个。 */
    private static final int RT_FIELDS = 24;

    /** 服务器不校验身份，随机 UUID 就够（不用真实账号）。 */
    private final String deviceId = java.util.UUID.randomUUID().toString();

    /** routeDirId → 站表坐标 [[站序,纬度,经度], ...]。站表不常变，缓存起来免得每次刷新都拉。 */
    private final java.util.concurrent.ConcurrentHashMap<String, double[][]> routeStations =
            new java.util.concurrent.ConcurrentHashMap<String, double[][]>();

    /**
     * 「线路名|开往」→ routeDirId。
     *
     * <p>界面沿用车来了/掌上公交的习惯，lineId 是 {@code 1|观鸟岛湿地公园} 这种合成串；
     * 西昌协议只认数字方向 ID（{@code 2}）。拿合成串去查 seq=7 / 95，服务器会<b>直接
     * 关闭连接</b>（不回包、不报错），客户端等满 15 秒后只能报「服务器没响应」。</p>
     *
     * <p>所以 nearby() 里每条记录都登记一次，详情页拿到合成串时先换回数字 ID。</p>
     */
    /** 线路名 → 该线路在附近数据里出现过的方向 ID（上下行）。换向按钮用它配对。 */
    private static final java.util.concurrent.ConcurrentHashMap<String, java.util.LinkedHashSet<String>>
            dirsByName = new java.util.concurrent.ConcurrentHashMap<>();

    /** 站表缓存：routeDirId → [时间戳, 站表 JSON]。换向要连查两个方向，缓存省一半请求。 */
    private static final java.util.concurrent.ConcurrentHashMap<String, Object[]> detailCache =
            new java.util.concurrent.ConcurrentHashMap<>();

    /* static：盯站服务和界面在不同实例上查同一条线路，映射要共享，
       否则后台盯站在冷启动（App 刚起、还没刷过附近）时必然失败。 */
    private static final java.util.concurrent.ConcurrentHashMap<String, String> routeDirByLineId =
            new java.util.concurrent.ConcurrentHashMap<String, String>();

    /** 上次用附近接口兜底反查的时间，1 分钟内不重复扫（避免每条未知线路都发一次 TCP）。 */
    private static volatile long lastNearbyLookup = 0L;

    /** 兜底反查用的西昌市中心坐标（胜利路/顺城街一带，站最密）。 */
    private static final double FALLBACK_LAT = 27.8861;
    private static final double FALLBACK_LNG = 102.2820;

    /** 纯数字 → 原样返回；合成串 → 查 nearby 时登记过的映射，查不到再就近反查一次。 */
    private String routeDirIdOf(String lineId) {
        String t = lineId == null ? "" : lineId.trim();
        if (t.isEmpty()) throw new IllegalArgumentException("缺少线路 ID");
        boolean digits = true;
        for (int i = 0; i < t.length(); i++) {
            if (!Character.isDigit(t.charAt(i))) { digits = false; break; }
        }
        if (digits) return t;
        String hit = lookup(t);
        if (hit == null) {
            /* 收藏 / 盯站 / 下车提醒是跨启动的：新进程里还没刷过附近，
               映射是空的。用市中心坐标扫一次 seq=2 现捞（结果会登记进映射）。 */
            if (System.currentTimeMillis() - lastNearbyLookup > 60000L) {
                lastNearbyLookup = System.currentTimeMillis();
                try { nearby(FALLBACK_LAT, FALLBACK_LNG, 8); } catch (Exception ignored) {}
                hit = lookup(t);
            }
        }
        if (hit == null) {
            throw new IllegalArgumentException(
                    "这条线路暂时没有实时方向，先回首页刷新一次附近站点再进来");
        }
        return hit;
    }

    private static String lookup(String lineId) {
        String hit = routeDirByLineId.get(lineId);
        if (hit != null) return hit;
        /* 「路」字、空格、全半角括号在不同来源里写法不一致，宽松比一遍 */
        String key = looseLineId(lineId);
        for (java.util.Map.Entry<String, String> e : routeDirByLineId.entrySet()) {
            if (looseLineId(e.getKey()).equals(key)) return e.getValue();
        }
        /* 只给了线路名（没有「|开往」）时按名字取第一个方向 */
        String bare = key.contains("|") ? key.substring(0, key.indexOf('|')) : key;
        for (java.util.Map.Entry<String, String> e : routeDirByLineId.entrySet()) {
            String k = looseLineId(e.getKey());
            String kb = k.contains("|") ? k.substring(0, k.indexOf('|')) : k;
            if (kb.equals(bare)) return e.getValue();
        }
        return null;
    }

    private static String looseLineId(String s) {
        if (s == null) return "";
        return s.replace("路", "").replace(" ", "").trim();
    }

    /**
     * 附近站点的实时车辆。
     *
     * <p>协议：握手帧 {@code magic+长度0+序号0}；请求载荷
     * {@code 1;时间戳;xc;用户ID,设备ID;纬度,经度;纬度;经度;0}；
     * 响应 {@code 1;时间戳;0,} 之后每 24 个字段一条车辆记录。</p>
     *
     * <p><b>不需要签名</b>（这一点和 {@code :8800} 的 REST 接口不同）。</p>
     *
     * <p>输出对齐 {@link MyGolbsClient#nearby}。</p>
     *
     * <p><b>只报能确定的字段</b>：协议只给了「车距本站多少米」，没有站表，
     * 所以算不出「还有几站」「还有几分钟」。这两个留 null，界面改用距离显示。
     * 不拿距离除以臆测车速去编一个 ETA 出来。</p>
     */
    public JSONObject nearby(double lat, double lng, int limit) throws Exception {
        String payload = "1;" + System.currentTimeMillis() + ";xc;"
                + deviceId + "," + deviceId + ";"
                + fmt(lat) + "," + fmt(lng) + ";" + fmt(lat) + ";" + fmt(lng) + ";0";
        String[] f = rtFields(rtQuery(2, payload));

        LinkedHashMap<String, java.util.List<JSONObject>> byStation = new LinkedHashMap<>();
        LinkedHashMap<String, Integer> stationDist = new LinkedHashMap<>();
        JSONArray allArrivals = new JSONArray();

        int total = f.length > 1 ? (f.length - 1) / RT_FIELDS : 0;
        for (int k = 0; k < total; k++) {
            int b = 1 + k * RT_FIELDS;
            if (b + RT_FIELDS > f.length) break;
            String stationName = f[b + 6].trim();
            String lineName = normalizeLineName(f[b + 2]);
            if (stationName.isEmpty() || lineName.isEmpty()) continue;

            JSONObject arr = new JSONObject();
            arr.put("stationName", stationName);
            /* 字段 4 是本站的站点 ID（不是距离！拿它和站表的 stationId 对得上） */
            String targetStationId = f[b + 4].trim();
            arr.put("stationId", targetStationId.isEmpty() ? stationName : targetStationId);
            arr.put("lineName", lineName);
            arr.put("toward", f[b + 10].trim());
            arr.put("lineId", lineName + "|" + f[b + 10].trim());
            /* 线路方向 ID 和「目标站站序」——补站数/ETA 要用；
               同时登记合成 lineId → 数字方向 ID，详情页按 lineId 进来时才认得出 */
            String routeDir = f[b + 1].trim();
            arr.put("routeDirId", routeDir);
            if (!routeDir.isEmpty()) {
                routeDirByLineId.put(lineName + "|" + f[b + 10].trim(), routeDir);
                routeDirByLineId.put(f[b + 2].trim(), routeDir);
                java.util.LinkedHashSet<String> ids = dirsByName.get(lineName);
                if (ids == null) {
                    ids = new java.util.LinkedHashSet<>();
                    dirsByName.put(lineName, ids);
                }
                ids.add(routeDir);
            }
            arr.put("targetOrder", (int) parseDouble(f[b + 5]));
            arr.put("plate", f[b + 0].trim());
            arr.put("firstTime", hhmm(f[b + 13]));
            arr.put("lastTime", hhmm(f[b + 14]));
            arr.put("fare", f[b + 12].trim());
            arr.put("busLat", parseDouble(f[b + 7]));
            arr.put("busLng", parseDouble(f[b + 8]));

            String status = f[b + 9].trim();
            if (status.startsWith("p")) {
                /* p0000 = 首站还没发车 */
                arr.put("preStartTime", hhmm(f[b + 13]));
                arr.put("arrived", false);
            } else {
                arr.put("arrived", isArriving(status));
            }
            /* 站表拿不到，这两个字段不编 */
            arr.put("etaSeconds", JSONObject.NULL);
            arr.put("stationsAway", JSONObject.NULL);

            java.util.List<JSONObject> bucket = byStation.get(stationName);
            if (bucket == null) {
                bucket = new ArrayList<JSONObject>();
                byStation.put(stationName, bucket);
                stationDist.put(stationName, (int) parseDouble(f[b + 3]));
            }
            bucket.add(arr);
            allArrivals.put(arr);
        }

        final LinkedHashMap<String, Integer> dists = stationDist;
        List<String> names = new ArrayList<String>(byStation.keySet());
        Collections.sort(names, new Comparator<String>() {
            @Override public int compare(String a, String b) {
                int da = dists.containsKey(a) ? dists.get(a) : Integer.MAX_VALUE;
                int db = dists.containsKey(b) ? dists.get(b) : Integer.MAX_VALUE;
                return da - db;
            }
        });

        JSONArray stops = new JSONArray();
        int cap = limit > 0 ? limit : names.size();
        for (int i = 0; i < names.size() && i < cap; i++) {
            String nm = names.get(i);
            JSONObject stop = new JSONObject();
            stop.put("stationId", nm);
            stop.put("name", nm);
            stop.put("distanceMeters", stationDist.containsKey(nm) ? stationDist.get(nm) : 0);
            java.util.List<JSONObject> bucket = byStation.get(nm);
            JSONArray arrs = new JSONArray();
            JSONArray lineNames = new JSONArray();
            Set<String> seen = new HashSet<String>();
            for (int j = 0; j < bucket.size(); j++) {
                JSONObject a = bucket.get(j);
                String ln = a.optString("lineName", "");
                /* 西昌是按「物理站点」返回的：同一条线的上下行会各来一条记录。
                   首页格子只写线路名（不区分方向），两条一起画就成了「26路 26路」。
                   同一线路只留第一条；另一方向在详情页换向看得到。
                   allArrivals 保留全部，搜索按线路名筛照样能用。 */
                if (!ln.isEmpty() && !seen.add(ln)) continue;
                arrs.put(a);
                if (!ln.isEmpty()) lineNames.put(ln);
            }
            stop.put("arrivals", arrs);
            stop.put("lineNameList", lineNames);
            stops.put(stop);
        }

        /* 补上「还有几站 / 约几分钟 / 距本站米数」：只给最近那个站点补，
           最多 6 条，避免首页一次发几十个 TCP 请求。 */
        if (stops.length() > 0) {
            JSONObject nearest = stops.optJSONObject(0);
            if (nearest != null) enrich(nearest.optJSONArray("arrivals"), 6);
        }

        JSONObject out = new JSONObject();
        out.put("stops", stops);
        out.put("allArrivals", allArrivals);
        return out;
    }

    /**
     * 给一批到站记录补「还有几站 / 约几分钟 / 车距本站米数」。
     *
     * <p>距离一律用站表坐标现算（Haversine），不用协议里的数字字段：
     * 附近接口的字段 4 和 seq=95 的字段 7 都是<b>站点 ID</b>，不是米数；
     * seq=96 的值和实算距离比值在 0.02~0.12 之间浮动，单位不是米。
     * 站表坐标算出的全程 20160 米和协议头声明的 20183 米只差 0.1%，可信。</p>
     */
    private void enrich(JSONArray arrivals, int maxRoutes) {
        if (arrivals == null) return;
        Set<String> done = new HashSet<String>();
        for (int i = 0; i < arrivals.length() && done.size() < maxRoutes; i++) {
            JSONObject a = arrivals.optJSONObject(i);
            if (a == null) continue;
            String routeDirId = a.optString("routeDirId", "");
            int targetOrder = a.optInt("targetOrder", 0);
            if (routeDirId.isEmpty() || targetOrder <= 0) continue;
            if (!done.add(routeDirId)) continue;
            try {
                JSONArray veh = vehicles(routeDirId,
                        (int) parseDouble(a.optString("stationId", "0")), targetOrder,
                        a.optDouble("busLat", 0), a.optDouble("busLng", 0));
                String plate = a.optString("plate", "");
                for (int k = 0; k < veh.length(); k++) {
                    JSONObject v = veh.optJSONObject(k);
                    if (v == null) continue;
                    if (!plate.isEmpty() && !plate.equals(v.optString("plate", ""))) continue;
                    applyProgress(a, v, routeDirId, targetOrder);
                    break;
                }
            } catch (Exception ignored) {
                /* 单条线路补不上就补不上，不能拖垮首页 */
            }
        }
    }

    /** 按车辆位置和目标站序，算出剩余站数、剩余距离、ETA。 */
    private void applyProgress(JSONObject a, JSONObject v, String routeDirId, int targetOrder)
            throws Exception {
        int busOrder = v.optInt("order", 0);
        if (busOrder <= 0) return;
        double speed = v.optDouble("speedKmh", 0);
        double busLat = v.optDouble("lat", 0), busLng = v.optDouble("lng", 0);

        double[][] st = stations(routeDirId);
        double meters = -1;
        if (st != null && busLat != 0 && busLng != 0) {
            /* 从车当前位置走到目标站：车→下一站 + 逐段累加到目标站 */
            meters = 0;
            for (int i = 0; i < st.length; i++) {
                if (st[i][0] < busOrder + 1) continue;      // 已经过的站
                if (st[i][0] > targetOrder) break;
                double lat = st[i][1], lng = st[i][2];
                if (st[i][0] == busOrder + 1) {
                    meters += distance(busLat, busLng, lat, lng);   // 车 → 下一站
                } else {
                    meters += distance(st[i - 1][1], st[i - 1][2], lat, lng);
                }
            }
            if (meters <= 0) meters = -1;
        }

        /* 站数：目标站序 − 车辆站序 + 1，和官方 App 的「4站 / 15站」对过 */
        int away = targetOrder - busOrder + 1;
        a.put("stationsAway", away > 0 ? away : JSONObject.NULL);
        a.put("arrived", away <= 1);
        /* 车已经开过目标站 */
        a.put("passed", away <= 0);
        a.put("remainingMeters", meters > 0 ? (int) Math.round(meters) : JSONObject.NULL);
        a.put("etaSeconds", JSONObject.NULL);
        /* 已经很近（<100 米）就直接算进站，别再显示「还有 2 站 / 0 分钟」 */
        if (meters > 0 && meters < 100) {
            a.put("arrived", true);
            a.put("stationsAway", 1);
            return;
        }
        /* 距离照给（停站的车也能显示还有多远）；
           停站 / 已过站 / 已到站都不给 ETA —— 拿 0 当速率除会得出无穷，编一个又是假的 */
        if (away <= 1 || speed < 5 || meters <= 0) return;
        double mps = speed * 1000.0 / 3600.0;
        a.put("etaSeconds", (int) Math.round(meters / mps));
    }

    /** 站表坐标 [[站序,纬度,经度], ...]，带缓存。 */
    private double[][] stations(String routeDirId) {
        double[][] cached = routeStations.get(routeDirId);
        if (cached != null) return cached;
        try {
            JSONObject d = lineDetail(routeDirId);
            JSONArray arr = d.optJSONArray("stations");
            if (arr == null || arr.length() == 0) return null;
            double[][] out = new double[arr.length()][3];
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                out[i][0] = o.optInt("order", i + 1);
                out[i][1] = o.optDouble("lat", 0);
                out[i][2] = o.optDouble("lng", 0);
            }
            routeStations.put(routeDirId, out);
            return out;
        } catch (Exception ignored) {
            return null;
        }
    }

    /** 两点球面距离（米）。 */
    private static double distance(double lat1, double lng1, double lat2, double lng2) {
        double r = Math.PI / 180;
        double dLat = (lat2 - lat1) * r;
        double dLng = (lng2 - lng1) * r;
        double x = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(lat1 * r) * Math.cos(lat2 * r)
                * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * 6371000 * Math.asin(Math.sqrt(x));
    }

    /** 发一次实时查询，返回第一个带载荷的响应帧。 */
    private String rtQuery(int seq, String payload) throws Exception {
        Socket sock = new Socket();
        try {
            sock.connect(new InetSocketAddress(RT_HOST, RT_PORT), 8000);
            sock.setSoTimeout(12000);
            OutputStream out = sock.getOutputStream();
            out.write(frame(new byte[0], 0));           // 握手
            out.flush();
            out.write(frame(payload.getBytes("UTF-8"), seq));
            out.flush();

            InputStream in = sock.getInputStream();
            byte[] acc = new byte[0];
            long deadline = System.currentTimeMillis() + 15000;
            while (System.currentTimeMillis() < deadline) {
                byte[] chunk = new byte[16384];
                int n = in.read(chunk);
                if (n < 0) break;
                byte[] merged = new byte[acc.length + n];
                System.arraycopy(acc, 0, merged, 0, acc.length);
                System.arraycopy(chunk, 0, merged, acc.length, n);
                acc = merged;

                int off = 0;
                while (acc.length - off >= 12) {
                    if (readInt(acc, off) != RT_MAGIC) { off = acc.length; break; }
                    int len = readInt(acc, off + 4);
                    if (len < 0 || len > 8 * 1024 * 1024) { off = acc.length; break; }
                    if (acc.length - off - 12 < len) break;
                    /* 只跳过握手回包（len=0）；「当地暂时没车」的响应只有十几个字节，
                       以前用 len>200 过滤会把空响应当成没收到，一直等到 soTimeout。 */
                    if (len > 0) return new String(acc, off + 12, len, "UTF-8");
                    off += 12 + len;
                }
                if (off > 0) {
                    byte[] rest = new byte[acc.length - off];
                    System.arraycopy(acc, off, rest, 0, rest.length);
                    acc = rest;
                }
            }
            throw new java.io.IOException("西昌实时服务器没响应，稍后再试");
        } finally {
            try { sock.close(); } catch (Exception ignored) {}
        }
    }

    private static byte[] frame(byte[] payload, int seq) {
        byte[] f = new byte[12 + payload.length];
        writeInt(f, 0, RT_MAGIC);
        writeInt(f, 4, payload.length);
        writeInt(f, 8, seq);
        System.arraycopy(payload, 0, f, 12, payload.length);
        return f;
    }

    private static int readInt(byte[] b, int off) {
        return ((b[off] & 0xFF) << 24) | ((b[off + 1] & 0xFF) << 16)
                | ((b[off + 2] & 0xFF) << 8) | (b[off + 3] & 0xFF);
    }

    private static void writeInt(byte[] b, int off, int v) {
        b[off] = (byte) (v >>> 24);
        b[off + 1] = (byte) (v >>> 16);
        b[off + 2] = (byte) (v >>> 8);
        b[off + 3] = (byte) v;
    }

    /** 拆出 "1;时间戳;0,<f>...," 里逗号分隔的字段（f[0] 是表头 0）。 */
    private static String[] rtFields(String text) {
        int i1 = text.indexOf(';');
        if (i1 < 0) return new String[0];
        int i2 = text.indexOf(';', i1 + 1);
        /* "1;<时间戳>;" 表示这个位置附近没有车，没有记录部分 */
        if (i2 < 0 || i2 + 1 >= text.length()) return new String[0];
        return text.substring(i2 + 1).split(",", -1);
    }

    /**
     * 线路名规范化：「107路下行(西宁-川兴车站)」→「107」。
     *
     * <p>其它数据源（车来了、掌上公交）的 lineName 不带「路」字，前端到处
     * {@code lineName + "路"} 拼接。西昌协议里自带「路」，不剥掉会显示成「39路路」。</p>
     */
    private static String normalizeLineName(String raw) {
        if (raw == null) return "";
        String t = raw.trim();
        /* 协议里括号有半角也有全角（如「环湖（建昌古城-建昌古城）」），两种都要截 */
        int p1 = t.indexOf('(');
        int p2 = t.indexOf('（');
        int paren = p1 < 0 ? p2 : (p2 < 0 ? p1 : Math.min(p1, p2));
        if (paren > 0) t = t.substring(0, paren);
        t = t.replace("上行", "").replace("下行", "").trim();
        if (t.endsWith("路")) t = t.substring(0, t.length() - 1).trim();
        return t;
    }

    /** l1 / l2 = 即将进站。更大的编号协议里没给出含义，不猜。 */
    private static boolean isArriving(String status) {
        return "l1".equals(status) || "l2".equals(status);
    }

    /** 协议给的是 0630 这种四位数，转成 06:30。 */
    private static String hhmm(String s) {
        if (s == null) return "";
        String t = s.trim();
        if (t.length() == 4 && Character.isDigit(t.charAt(0))) {
            return t.substring(0, 2) + ":" + t.substring(2);
        }
        return t;
    }

    private static double parseDouble(String s) {
        if (s == null) return 0;
        try { return Double.parseDouble(s.trim()); } catch (Exception e) { return 0; }
    }

    private static String fmt(double v) {
        return String.format(java.util.Locale.US, "%.6f", v);
    }

    // ------------------------------------------------- 站表 / 速率（seq=7 / 95）

    /**
     * 线路站表。{@code routeDirId} 就是附近接口里每条记录的第 2 个字段（如 107路 上行=184、下行=185）。
     *
     * <p>协议 seq=7，请求体只有这个 id。响应形如
     * {@code 184:107路:0::0630:2100:20183:票价:1;1,2957,西宁,lat,lng;2,2958,火车北站,lat,lng;...}</p>
     *
     * <p>输出对齐 {@link MyGolbsClient#lineDetail}。</p>
     */
    public JSONObject lineDetail(String routeDirId) throws Exception {
        routeDirId = routeDirIdOf(routeDirId);
        String text = rtQuery(7, "1;" + System.currentTimeMillis() + ";xc;;;" + routeDirId);
        String[] parts = text.split(";", -1);
        JSONObject out = new JSONObject();
        JSONArray stations = new JSONArray();
        out.put("lineId", routeDirId);
        out.put("stations", stations);
        if (parts.length < 3) return out;

        String[] head = parts[2].split(":", -1);
        String lineName = head.length > 1 ? head[1].trim() : "";
        String lineNo = normalizeLineName(lineName);

        out.put("name", lineNo);
        out.put("fullName", lineName);
        out.put("firstTime", hhmm(head.length > 4 ? head[4] : ""));
        out.put("lastTime", hhmm(head.length > 5 ? head[5] : ""));
        out.put("totalLength", head.length > 6 ? head[6] : "");
        out.put("price", head.length > 7 ? head[7].trim() : "");

        /* parts[3] 里是全部站点，用 ':' 分隔，每个站用 ',' 分字段 */
        String block = parts.length > 3 ? parts[3] : "";
        String[] segs = block.split(":", -1);
        for (int i = 0; i < segs.length; i++) {
            String seg = segs[i].trim();
            if (seg.isEmpty()) continue;
            String[] f = seg.split(",", -1);
            if (f.length < 5) continue;
            JSONObject item = new JSONObject();
            int order = (int) parseDouble(f[0]);
            item.put("stationId", f[1]);
            item.put("order", order);
            item.put("rawOrder", order);
            item.put("name", f[2]);
            item.put("lat", parseDouble(f[3]));
            item.put("lng", parseDouble(f[4]));
            item.put("suspended", false);
            item.put("specialLabel", "");
            item.put("specialNote", "");
            item.put("loop", false);
            item.put("loopLen", 0);
            stations.put(item);
        }
        int n = stations.length();
        out.put("startSn", n > 0 ? stations.optJSONObject(0).optString("name", "") : "");
        out.put("endSn", n > 0 ? stations.optJSONObject(n - 1).optString("name", "") : "");
        out.put("depDesc", "");
        out.put("depIntervalM", -1);
        out.put("departLeft", 0);
        out.put("departRight", 0);
        out.put("intervalLeft", -1);
        out.put("intervalRight", -1);
        out.put("preArrivalTime", "");
        return out;
    }

    /**
     * 线路上的车辆位置 + <b>速率</b>。协议 seq=95。
     *
     * <p>每条车辆：{@code routeDirId:线路名(含方向):车牌:车牌:lat:lng:速率km/h:距下一站米:下一站名:当前站序:车辆实时ID:ts:ts:?:1}</p>
     */
    public JSONArray vehicles(String routeDirId) throws Exception {
        return vehicles(routeDirId, 0, 0, 0, 0);
    }

    /**
     * seq=95 必须带 {@code 距站距离;站序;纬度;经度}，少一个服务器都不回包。
     * 这些值取附近接口里那条记录的对应字段。
     */
    public JSONArray vehicles(String routeDirId, int dist, int order, double lat, double lng)
            throws Exception {
        routeDirId = routeDirIdOf(routeDirId);
        String body = "1;" + System.currentTimeMillis() + ";xc;;;" + routeDirId
                + ";" + dist + ";" + order + ";" + fmt(lat) + ";" + fmt(lng);
        String text = rtQuery(95, body);
        String[] parts = text.split(";", -1);
        JSONArray out = new JSONArray();
        for (int i = 2; i < parts.length; i++) {
            String seg = parts[i].trim();
            if (seg.isEmpty()) continue;
            String[] f = seg.split(":", -1);
            if (f.length < 11) continue;
            JSONObject v = new JSONObject();
            v.put("routeDirId", f[0]);
            v.put("lineName", normalizeLineName(f[1]));
            v.put("plate", f[2]);
            v.put("lat", parseDouble(f[4]));
            v.put("lng", parseDouble(f[5]));
            /* 速率 km/h */
            v.put("speedKmh", parseDouble(f[6]));
            /* 字段 7 是「下一站的站点 ID」，不是距离——和字段 8 的站名一一对应，
               曾误当米数显示过。 */
            v.put("nextStationId", f[7].trim());
            v.put("nextStation", f[8]);
            /* 车辆当前站序，和站表的 order 同量纲 */
            v.put("order", (int) parseDouble(f[9]));
            v.put("realtimeId", f[10]);
            out.put(v);
        }
        return out;
    }

    /**
     * 到站。用 seq=95 拿车辆站序和速率，再按站表距离算剩余站数和 ETA。
     *
     * <p><b>站数</b>：{@code 目标站站序 - 车辆站序 + 1}。这个公式拿官方 App 的
     * 「4站 / 15站」逐条对过，一致。</p>
     *
     * <p><b>ETA</b>：剩余站数 × 平均站距 ÷ 实测速率。速率取协议给的实时值（km/h）。
     * 车速低于 5km/h 当作停站，不给 ETA —— 拿 0 去除非得不出「马上到」就是无穷大，
     * 两个都是假的。</p>
     */
    public JSONArray arrivals(String routeDirId, JSONObject station) throws Exception {
        routeDirId = routeDirIdOf(routeDirId);
        int targetOrder = station == null ? 0 : station.optInt("order", 0);
        JSONArray veh = vehicles(routeDirId, 0, targetOrder,
                station == null ? 0 : station.optDouble("lat", 0),
                station == null ? 0 : station.optDouble("lng", 0));
        JSONArray out = new JSONArray();
        for (int i = 0; i < veh.length(); i++) {
            JSONObject v = veh.optJSONObject(i);
            if (v == null) continue;
            int busOrder = v.optInt("order", 0);
            JSONObject a = new JSONObject();
            a.put("lineId", routeDirId);
            a.put("lineName", v.optString("lineName", ""));
            String plate = v.optString("plate", "");
            /* 待发车的记录车牌可能是 null，用实时 ID 兜底保证 busId 唯一 */
            a.put("busId", plate.isEmpty() || "null".equals(plate)
                    ? "nv-" + v.optString("realtimeId", "") : plate);
            a.put("plate", plate);
            a.put("lat", v.optDouble("lat", 0));
            a.put("lng", v.optDouble("lng", 0));
            a.put("nextStation", v.optString("nextStation", ""));
            a.put("order", busOrder);
            a.put("speedKmh", v.optDouble("speedKmh", 0));

            /* 站数、剩余距离、ETA 统一走 applyProgress（用站表坐标算距离） */
            applyProgress(a, v, routeDirId, targetOrder);
            out.put(a);
        }
        return out;
    }

    /**
     * 详情页矩阵：站表 + 全线车辆 + 每辆车到各站的时间。
     *
     * <p>西昌一次 seq=95 就能拿到全线所有车辆，不用像掌上公交那样逐站查，
     * 所以这里只发 2 个 TCP 请求（站表 + 车辆）。</p>
     *
     * <p>输出对齐 {@link MyGolbsClient#stationMatrix}。</p>
     */
    /** 站表带缓存（10 分钟），换向时两个方向各查一次就够。 */
    private JSONObject lineDetailCached(String routeDirId) throws Exception {
        Object[] hit = detailCache.get(routeDirId);
        if (hit != null && System.currentTimeMillis() - ((Long) hit[0]) < 600000L) {
            return (JSONObject) hit[1];
        }
        JSONObject d = lineDetail(routeDirId);
        detailCache.put(routeDirId, new Object[]{System.currentTimeMillis(), d});
        return d;
    }

    /**
     * 同一条线路的两个方向（详情页的换向芯片 + 每方向首末班）。
     *
     * <p>协议没有「按名字查线路」的接口，方向 ID 只能从两处来：</p>
     * <ol>
     *   <li>附近接口（seq=2）里同名线路出现过的方向——上下行都在跑时最可靠；</li>
     *   <li>兜底：探测 {@code routeDirId ± 1}，站表线路名对得上才算。
     *       实测 39路=412/413、107路=184/185、11路=64/65 都相邻；
     *       环线（如 1路=2）没有反向，探测会空手而归，正好不画换向。</li>
     * </ol>
     *
     * <p>只有单方向时也返回 1 条：前端据此显示「首班/末班」，而不是什么都不显示。</p>
     */
    public JSONArray directions(String routeDirId) throws Exception {
        String cur = routeDirIdOf(routeDirId);
        JSONObject curDetail;
        try { curDetail = lineDetailCached(cur); } catch (Exception e) { return new JSONArray(); }
        String name = curDetail.optString("name", "");
        java.util.LinkedHashSet<String> ids = new java.util.LinkedHashSet<>();
        ids.add(cur);
        java.util.LinkedHashSet<String> known = dirsByName.get(name);
        if (known != null) ids.addAll(known);
        if (ids.size() < 2) {
            try {
                int base = Integer.parseInt(cur);
                for (int cand : new int[]{base + 1, base - 1}) {
                    if (cand <= 0) continue;
                    String cs = String.valueOf(cand);
                    try {
                        JSONObject d = lineDetailCached(cs);
                        JSONArray st = d.optJSONArray("stations");
                        if (name.equals(d.optString("name", "")) && st != null && st.length() > 0) {
                            ids.add(cs);
                            break;
                        }
                    } catch (Exception ignored) {}
                }
            } catch (NumberFormatException ignored) {}
        }
        JSONArray out = new JSONArray();
        for (String id : ids) {
            JSONObject d;
            try { d = id.equals(cur) ? curDetail : lineDetailCached(id); }
            catch (Exception e) { continue; }
            if (d == null || d.optJSONArray("stations") == null
                    || d.optJSONArray("stations").length() == 0) continue;
            out.put(new JSONObject()
                    .put("lineId", id)
                    .put("name", d.optString("name", ""))
                    .put("fullName", d.optString("fullName", ""))
                    .put("firstTime", d.optString("firstTime", ""))
                    .put("lastTime", d.optString("lastTime", ""))
                    .put("startSn", d.optString("startSn", ""))
                    .put("endSn", d.optString("endSn", "")));
        }
        return out;
    }

    public JSONObject stationMatrix(String routeDirId, int fromOrder, int window) throws Exception {
        routeDirId = routeDirIdOf(routeDirId);
        JSONObject detail = lineDetail(routeDirId);
        JSONArray all = detail.optJSONArray("stations");
        if (all == null || all.length() == 0) {
            throw new IllegalArgumentException("这条线路没有站点数据");
        }

        /* 目标站：从 fromOrder 起往后的 window 个 */
        List<JSONObject> targets = new ArrayList<JSONObject>();
        int cap = window > 0 ? window : 80;
        for (int i = 0; i < all.length() && targets.size() < cap; i++) {
            JSONObject st = all.optJSONObject(i);
            if (st != null && st.optInt("order", 0) >= fromOrder) targets.add(st);
        }
        if (targets.isEmpty()) throw new IllegalArgumentException("这条线路上没有可查询的站点");

        int terminusOrder = all.optJSONObject(all.length() - 1).optInt("order", 0);
        int queriedFrom = targets.get(0).optInt("order", 0);
        int queriedTo = targets.get(targets.size() - 1).optInt("order", 0);

        /* 全线车辆只查一次 */
        JSONArray veh = vehicles(routeDirId, queriedFrom, fromOrder,
                targets.get(0).optDouble("lat", 0), targets.get(0).optDouble("lng", 0));

        double[][] pts = stations(routeDirId);
        JSONArray busesOut = new JSONArray();
        for (int i = 0; i < veh.length(); i++) {
            JSONObject v = veh.optJSONObject(i);
            if (v == null) continue;
            int busOrder = v.optInt("order", 0);
            if (busOrder <= 0) continue;
            String plate = v.optString("plate", "");
            JSONObject item = new JSONObject();
            item.put("busId", plate.isEmpty() || "null".equals(plate)
                    ? "nv-" + v.optString("realtimeId", "") : plate);
            item.put("plate", plate);
            item.put("order", busOrder);
            item.put("lat", v.optDouble("lat", 0));
            item.put("lng", v.optDouble("lng", 0));
            item.put("speedKmh", v.optDouble("speedKmh", 0));
            item.put("terminusOrder", terminusOrder);
            item.put("stationsAway", Math.max(0, fromOrder - busOrder));
            item.put("stationsToEnd", Math.max(0, terminusOrder - busOrder));
            item.put("passedSelected", busOrder > fromOrder);

            JSONArray slices = new JSONArray();
            for (int k = 0; k < targets.size(); k++) {
                JSONObject st = targets.get(k);
                int order = st.optInt("order", 0);
                JSONObject slice = new JSONObject();
                slice.put("order", order);
                slice.put("name", st.optString("name", ""));
                slice.put("passed", order < busOrder);
                slice.put("arrivalAt", JSONObject.NULL);
                slice.put("etaSeconds", JSONObject.NULL);
                if (order >= busOrder && pts != null) {
                    double meters = legMeters(pts, v.optDouble("lat", 0), v.optDouble("lng", 0),
                            busOrder, order);
                    double speed = v.optDouble("speedKmh", 0);
                    if (meters > 0 && speed >= 5) {
                        slice.put("etaSeconds", (int) Math.round(meters / (speed * 1000.0 / 3600.0)));
                    }
                }
                slices.put(slice);
            }
            item.put("times", slices);
            busesOut.put(item);
        }

        JSONArray stationsOut = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject st = all.optJSONObject(i);
            if (st == null) continue;
            stationsOut.put(new JSONObject()
                    .put("order", st.optInt("order"))
                    .put("name", st.optString("name"))
                    .put("stationId", st.optString("stationId"))
                    .put("lat", st.optDouble("lat", 0))
                    .put("lng", st.optDouble("lng", 0))
                    .put("suspended", false)
                    .put("loop", false)
                    .put("loopLen", 0));
        }

        JSONObject lineOut = new JSONObject();
        lineOut.put("lineId", detail.optString("lineId"));
        lineOut.put("name", detail.optString("name"));
        lineOut.put("startSn", detail.optString("startSn"));
        lineOut.put("endSn", detail.optString("endSn"));
        lineOut.put("firstTime", detail.optString("firstTime"));
        lineOut.put("lastTime", detail.optString("lastTime"));
        lineOut.put("price", detail.optString("price", ""));
        lineOut.put("depDesc", "");
        lineOut.put("depIntervalM", -1);
        lineOut.put("departLeft", 0);
        lineOut.put("departRight", 0);

        JSONObject out = new JSONObject();
        out.put("line", lineOut);
        out.put("stations", stationsOut);
        out.put("buses", busesOut);
        out.put("queriedFrom", queriedFrom);
        out.put("queriedTo", queriedTo);
        /* 换向芯片 + 每方向首末班（西昌没有 lines 接口，只能自己配方向） */
        try { out.put("directions", directions(routeDirId)); } catch (Exception ignored) {}
        return out;
    }

    /** 从车当前位置沿站序走到目标站的里程（米）。 */
    private static double legMeters(double[][] pts, double busLat, double busLng,
                                    int busOrder, int targetOrder) {
        if (targetOrder < busOrder) return -1;
        double meters = 0;
        boolean first = true;
        for (int i = 0; i < pts.length; i++) {
            int order = (int) pts[i][0];
            if (order < busOrder + 1) continue;
            if (order > targetOrder) break;
            if (order == busOrder + 1 && busLat != 0 && busLng != 0) {
                meters += distance(busLat, busLng, pts[i][1], pts[i][2]);
                first = false;
            } else if (i > 0) {
                meters += distance(pts[i - 1][1], pts[i - 1][2], pts[i][1], pts[i][2]);
                first = false;
            }
        }
        return first ? -1 : meters;
    }

}
