package com.chengdu.bus;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

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
}
