package com.chengdu.bus;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * 掌上公交（mygolbs）数据源 —— 车来了没有覆盖城市（德阳/广元/广安/甘孜/阿坝）的补充。
 *
 * <p>接口比车来了简单：POST 表单到 {@code https://h5.mygolbs.com/ApiData.do}，
 * 无签名、无 token、无加密，直接返回 JSON。命门是 Origin 头必须是
 * {@code https://h5.mygolbs.com}（末尾无斜杠）——错了会返回一个 47 字节占位串，
 * 症状是「永远查不到」。</p>
 *
 * <p>本类输出与 {@link ChelaileClient} **完全一致的 JSON 结构**，这样页面 UI 一行都不用改：
 * 页面按 cityId 查询时，BusBridge 把 mygolbs 城市分流到这里，拿到的格式和车来了相同。</p>
 *
 * <p>常用 CMD：
 * <ul>
 *   <li>101 城市列表</li>
 *   <li>102 站点搜索（KEYWORD）</li>
 *   <li>103 线路站表（LINENAME + DIRECTION）→ 站序/坐标/首末班</li>
 *   <li>104 实时车辆 + 到站预测（LINENAME + DIRECTION + STATIONORDER）</li>
 *   <li>105 经过某站的线路（STATIONNAME）→ 含 neartext 到站文本、首末班</li>
 *   <li>106 附近站点（LAT + LNG）</li>
 *   <li>115 经过某站的线路 V2（STATIONNAME + MYLAT/MYLNG + ALL=1）</li>
 *   <li>119 城市线路目录（CITYNAME）</li>
 * </ul>
 */
public final class MyGolbsClient {

    private static final String API = "https://h5.mygolbs.com/ApiData.do";
    private static final String ORIGIN = "https://h5.mygolbs.com";
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/120 Mobile Safari/537.36";

    /** 掌上公交城市：cityId → 中文城市名（用作接口的 CITYNAME）。 */
    private static final String[][] CITIES = {
        {"mg-deyang", "德阳市"},
        {"mg-guangyuan", "广元市"},
        {"mg-guangan", "广安市"},
        {"mg-ganzi", "甘孜藏族自治州"},
        {"mg-aba", "阿坝藏族羌族自治州"},
    };

    /** cityId 是不是掌上公交的城市。 */
    public static boolean isMine(String cityId) {
        if (cityId == null) return false;
        return cityId.trim().startsWith("mg-");
    }

    /** cityId → 中文城市名；不认识返回空串。 */
    public static String cityNameOfId(String cityId) {
        if (cityId == null) return "";
        for (String[] c : CITIES) if (c[0].equals(cityId.trim())) return c[1];
        return "";
    }

    /** 中文城市名 → cityId；不认识返回空串。 */
    public static String cityIdOfName(String name) {
        if (name == null) return "";
        String key = name.trim();
        for (String[] c : CITIES) {
            if (c[1].equals(key) || c[1].replace("市", "").equals(key)) return c[0];
        }
        return "";
    }

    /** 掌上公交城市表（给前端城市选择器）。 */
    public static JSONArray cityTable() {
        JSONArray out = new JSONArray();
        try {
            for (String[] c : CITIES) {
                JSONObject item = new JSONObject();
                item.put("cityId", c[0]);
                item.put("name", c[1].replace("市", "").replace("藏族自治州", ""));
                item.put("group", c[0].contains("ganzi") || c[0].contains("aba") ? "川西" : "川北");
                item.put("level", "city");
                item.put("source", "mygolbs");
                out.put(item);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private final String cityId;
    private final String cityName;

    public MyGolbsClient(String cityId) {
        this.cityId = cityId;
        String n = cityNameOfId(cityId);
        this.cityName = n.isEmpty() ? cityId : n;
    }

    public String cityId() { return cityId; }
    public String cityName() { return cityName; }

    /** 发一个 CMD 请求，返回整个 JSON。 */
    private JSONObject cmd(JSONObject params) throws Exception {
        StringBuilder body = new StringBuilder();
        java.util.Iterator<String> keys = params.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            if (body.length() > 0) body.append('&');
            body.append(URLEncoder.encode(k, "UTF-8")).append('=')
                    .append(URLEncoder.encode(String.valueOf(params.opt(k)), "UTF-8"));
        }
        HttpURLConnection conn = (HttpURLConnection) new URL(API).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(18000);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Origin", ORIGIN);           // 命门：末尾不能有斜杠
            conn.setRequestProperty("Referer", ORIGIN + "/");
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            conn.setRequestProperty("Accept", "application/json, text/plain, */*");
            conn.getOutputStream().write(body.toString().getBytes(StandardCharsets.UTF_8));
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in == null) throw new ApiException("HTTP " + code);
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            in.close();
            String text = new String(buf.toByteArray(), StandardCharsets.UTF_8);
            JSONObject json = new JSONObject(text);
            if (String.valueOf(json.opt("status")).equals("1")) return json;
            throw new ApiException(json.optString("msg", "接口返回失败"));
        } finally {
            conn.disconnect();
        }
    }

    private JSONObject base(String cmd) throws Exception {
        JSONObject p = new JSONObject();
        p.put("CMD", cmd);
        p.put("CITYNAME", cityName);
        return p;
    }

    /** 线路搜索：城市线路目录里筛 lineName 含关键字的（掌上公交没有 key 搜索接口）。 */
    public JSONArray searchLines(String keyword) throws Exception {
        JSONObject p = base("119");
        JSONObject data = cmd(p);
        JSONArray lines = data.optJSONArray("buslines");
        JSONArray out = new JSONArray();
        if (lines == null) return out;
        String kw = keyword == null ? "" : keyword.trim();
        /* 同名线路上下行各一条，按 lineName + direction 去重 */
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (int i = 0; i < lines.length(); i++) {
            JSONObject line = lines.optJSONObject(i);
            if (line == null) continue;
            String name = line.optString("lineName", "");
            if (name.isEmpty()) continue;
            if (!kw.isEmpty() && !name.contains(kw)) continue;
            int dir = "2".equals(line.optString("upperOrDown")) ? 1 : 0;
            String key = name + "|" + dir;
            if (!seen.add(key)) continue;
            JSONObject item = new JSONObject();
            /* lineId 带方向后缀：上下行必须是不同的 id，否则页面换向时
               dir.lineId === lv.lineId 恒成立，所有方向都被当成当前方向、点不动。
               detail/arrivals 已支持解析「线路名|方向」。 */
            item.put("lineId", name + "|" + dir);
            item.put("name", name);
            item.put("direction", dir);
            item.put("startSn", line.optString("from", ""));
            item.put("endSn", line.optString("to", ""));
            item.put("firstTime", line.optString("beginTime", ""));
            item.put("lastTime", line.optString("endTime", ""));
            out.put(item);
            if (out.length() >= 30) break;
        }
        return out;
    }

    /** 站点搜索：CMD=102。 */
    public JSONArray searchStations(String keyword) throws Exception {
        JSONObject p = base("102");
        p.put("KEYWORD", keyword == null ? "" : keyword);
        JSONObject data = cmd(p);
        JSONArray sts = data.optJSONArray("data");
        JSONArray out = new JSONArray();
        if (sts == null) return out;
        for (int i = 0; i < sts.length(); i++) {
            JSONObject st = sts.optJSONObject(i);
            if (st == null) continue;
            String name = st.optString("stationName", st.optString("name", ""));
            if (name.isEmpty()) continue;
            JSONObject item = new JSONObject();
            item.put("stationId", st.optString("stationID", name));
            item.put("name", name);
            item.put("lat", st.optDouble("lat", st.optDouble("station_lat", 0)));
            item.put("lng", st.optDouble("lon", st.optDouble("station_lon", 0)));
            item.put("distance", st.optDouble("dis", st.optDouble("distance", 0)));
            out.put(item);
        }
        return out;
    }

    /**
     * 附近站点 + 每条线路最近一辆车的到站。
     * 先用 CMD=106 按坐标拿附近站点，再对每个站点用 CMD=105 拿经过的线路与到站文本。
     */
    public JSONObject nearby(double lat, double lng, int limit) throws Exception {
        JSONObject p = base("106");
        p.put("LAT", String.valueOf(lat));
        p.put("LNG", String.valueOf(lng));
        JSONObject data = cmd(p);
        JSONArray near = data.optJSONArray("data");
        JSONArray stops = new JSONArray();
        JSONArray allArrivals = new JSONArray();
        if (near == null) {
            JSONObject out = new JSONObject();
            out.put("stops", stops);
            out.put("allArrivals", allArrivals);
            return out;
        }
        int count = Math.min(near.length(), limit);
        for (int i = 0; i < count; i++) {
            JSONObject st = near.optJSONObject(i);
            if (st == null) continue;
            String name = st.optString("name", "");
            JSONObject stop = new JSONObject();
            stop.put("stationId", name);
            stop.put("name", name);
            stop.put("distanceMeters", st.optInt("dis", 0));
            double sla = st.optDouble("lat", 0), slo = st.optDouble("lon", 0);
            stop.put("lat", sla);
            stop.put("lng", slo);
            JSONArray names = new JSONArray();
            JSONArray own = new JSONArray();
            try {
                JSONObject lines = cmd(byStation("105", name));
                JSONArray la = lines.optJSONArray("data");
                if (la != null) {
                    java.util.Set<String> dedup = new java.util.HashSet<>();
                    for (int k = 0; k < la.length(); k++) {
                        JSONObject line = la.optJSONObject(k);
                        if (line == null) continue;
                        String lineName = line.optString("lineName", "");
                        if (lineName.isEmpty()) continue;
                        if (dedup.add(lineName)) names.put(lineName);
                        JSONObject arr = new JSONObject();
                        arr.put("stationId", name);
                        arr.put("stationName", name);
                        arr.put("stationOrder", line.optInt("stationOrder", 0));
                        int d = "2".equals(line.optString("upperOrDown")) ? 1 : 0;
                        arr.put("lineId", lineName + "|" + d);
                        arr.put("lineName", lineName);
                        arr.put("firstTime", line.optString("beginTime", ""));
                        arr.put("lastTime", line.optString("endTime", ""));
                        arr.put("toward", line.optString("to", ""));
                        /* neartext 形如「即将到站 [开往 xxx]」/「3站 5分钟」 */
                        String nearText = line.optString("neartext", "");
                        int eta = parseEta(nearText);
                        int away = parseAway(nearText);
                        arr.put("stationsAway", away);
                        arr.put("etaSeconds", eta > 0 ? eta : JSONObject.NULL);
                        arr.put("arrived", nearText.contains("即将到站") || away == 0);
                        own.put(arr);
                        allArrivals.put(arr);
                    }
                }
            } catch (Exception ignored) {
                // 单个站点的线路查询失败不影响其它站点
            }
            stop.put("arrivals", own);
            stop.put("lineNameList", names);
            stops.put(stop);
        }
        JSONObject out = new JSONObject();
        out.put("stops", stops);
        out.put("allArrivals", allArrivals);
        return out;
    }

    /** 线路详情：CMD=103 站表，映射成和车来了 lineDetail 相同的结构。 */
    public JSONObject lineDetail(String lineId) throws Exception {
        /* lineId 里可能带方向后缀（"2路|1"），拆开 */
        String name = lineId;
        int dir = 0;
        int bar = lineId.indexOf('|');
        if (bar > 0) {
            name = lineId.substring(0, bar);
            try { dir = Integer.parseInt(lineId.substring(bar + 1)); } catch (Exception ignored) {}
        }
        JSONObject p = base("103");
        p.put("LINENAME", name);
        p.put("DIRECTION", String.valueOf(dir == 1 ? 2 : 1));
        JSONObject data = cmd(p);
        JSONArray sts = data.optJSONArray("data");
        JSONArray outStations = new JSONArray();
        boolean loop = data.optInt("loopType", 0) == 1;
        int loopLen = sts == null ? 0 : sts.length();
        if (sts != null) {
            for (int i = 0; i < sts.length(); i++) {
                JSONObject st = sts.optJSONObject(i);
                if (st == null) continue;
                JSONObject item = new JSONObject();
                int order = st.optInt("stationOrder", i + 1);
                item.put("stationId", st.optString("stationName", String.valueOf(order)));
                item.put("order", order);
                item.put("rawOrder", order);
                item.put("name", st.optString("stationName", st.optString("showName", "")));
                item.put("lat", st.optDouble("station_lat", 0));
                item.put("lng", st.optDouble("station_lon", 0));
                item.put("suspended", false);
                item.put("specialLabel", "");
                item.put("specialNote", "");
                item.put("loop", loop);
                item.put("loopLen", loopLen);
                outStations.put(item);
            }
        }
        String first = data.optString("beginTime", "");
        String last = data.optString("endTime", "");
        JSONObject out = new JSONObject();
        out.put("lineId", lineId);
        out.put("name", data.optString("routeName", name));
        out.put("startSn", outStations.length() > 0 ? outStations.optJSONObject(0).optString("name") : "");
        out.put("endSn", outStations.length() > 0 ? outStations.optJSONObject(outStations.length() - 1).optString("name") : "");
        out.put("firstTime", first);
        out.put("lastTime", last);
        out.put("price", data.optString("commonts", ""));
        out.put("depDesc", "");
        out.put("depIntervalM", -1);
        out.put("departLeft", 0);
        out.put("departRight", 0);
        out.put("intervalLeft", -1);
        out.put("intervalRight", -1);
        out.put("preArrivalTime", data.optString("planTime", ""));
        out.put("stations", outStations);
        return out;
    }

    /** 到站：CMD=104，把 mygolbs 的车辆和预测映射成和车来了 arrivals 相同的结构。 */
    public JSONArray arrivals(String lineId, JSONObject station) throws Exception {
        String name = lineId;
        int dir = 0;
        int bar = lineId.indexOf('|');
        if (bar > 0) {
            name = lineId.substring(0, bar);
            try { dir = Integer.parseInt(lineId.substring(bar + 1)); } catch (Exception ignored) {}
        }
        int order = station.optInt("order", 1);
        JSONObject p = base("104");
        p.put("LINENAME", name);
        p.put("DIRECTION", String.valueOf(dir == 1 ? 2 : 1));
        p.put("STATIONORDER", String.valueOf(order));
        JSONObject data = cmd(p);

        /* list[]：每辆车的当前位置，index 就是车所在的站序（和 CMD=103 的 stationOrder 同量纲）。
           按车牌建索引，给下面的预测补上「车当前在第几站」。 */
        java.util.HashMap<String, Integer> busOrder = new java.util.HashMap<>();
        java.util.HashMap<String, Double> busDist = new java.util.HashMap<>();
        JSONArray positions = data.optJSONArray("list");
        if (positions != null) {
            for (int i = 0; i < positions.length(); i++) {
                JSONObject b = positions.optJSONObject(i);
                if (b == null) continue;
                String plate = b.optString("busNumber", "");
                if (plate.isEmpty()) continue;
                busOrder.put(plate, b.optInt("index", 0));
                busDist.put(plate, b.optDouble("busToStationNiheDistance", -1));
            }
        }

        /* routeOnStationRTimeInfoList：每辆车到「目标站」的预测 */
        JSONArray forecasts = data.optJSONArray("routeOnStationRTimeInfoList");
        JSONArray out = new JSONArray();
        List<JSONObject> list = new ArrayList<>();
        if (forecasts != null) {
            for (int i = 0; i < forecasts.length(); i++) {
                JSONObject f = forecasts.optJSONObject(i);
                if (f == null) continue;
                String plate = f.optString("busNumber", "");
                if (plate.isEmpty()) continue;
                int away = parseAway(f.optString("busToStationTips", ""));
                if (f.has("busToStationCount")) away = f.optInt("busToStationCount", away);
                int etaMin = f.optInt("busToStationTime", -1);
                int curOrder = busOrder.containsKey(plate) ? busOrder.get(plate) : Math.max(0, order - away);
                JSONObject item = new JSONObject();
                item.put("busId", plate);
                item.put("plate", plate);
                /* order = 车当前所在站序（不是距目标站站数），和车来了语义一致 */
                item.put("order", curOrder);
                item.put("stationsAway", Math.max(0, order - curOrder));
                item.put("distanceMeters", f.optInt("busToStationDistance", -1));
                item.put("etaSeconds", etaMin > 0 ? etaMin * 60 : JSONObject.NULL);
                item.put("arrivalAt", JSONObject.NULL);
                list.add(item);
            }
        }
        java.util.Collections.sort(list, new Comparator<JSONObject>() {
            @Override public int compare(JSONObject a, JSONObject b) {
                return Integer.compare(a.optInt("order"), b.optInt("order"));
            }
        });
        for (JSONObject item : list) out.put(item);
        return out;
    }

    /** 单车逐站矩阵：按站表逐站查 arrivals，按车牌串起来。
     *  输出结构必须和 ChelaileClient.stationMatrix 完全一致（line/stations/buses/queriedFrom/queriedTo），
     *  页面会读 data.line.firstTime 等字段——缺了会直接报 undefined.firstTime。 */
    public JSONObject stationMatrix(String lineId, int fromOrder, int window) throws Exception {
        JSONObject detail = lineDetail(lineId);
        JSONArray all = detail.getJSONArray("stations");
        List<JSONObject> targets = new ArrayList<>();
        for (int i = 0; i < all.length() && targets.size() < window; i++) {
            JSONObject st = all.optJSONObject(i);
            if (st != null && st.optInt("order", 0) >= fromOrder) targets.add(st);
        }
        if (targets.isEmpty()) throw new ApiException("这条线路上没有可查询的站点");

        LinkedHashMap<String, JSONObject> buses = new LinkedHashMap<>();
        LinkedHashMap<String, java.util.TreeMap<Integer, JSONObject>> times = new LinkedHashMap<>();
        for (JSONObject st : targets) {
            JSONArray arr = arrivals(lineId, st);
            for (int k = 0; k < arr.length(); k++) {
                JSONObject bus = arr.optJSONObject(k);
                if (bus == null) continue;
                String key = bus.optString("busId", "");
                if (key.isEmpty()) continue;
                if (!buses.containsKey(key)) {
                    JSONObject meta = new JSONObject();
                    meta.put("busId", key);
                    meta.put("plate", bus.optString("plate"));
                    meta.put("order", bus.optInt("order"));
                    buses.put(key, meta);
                    times.put(key, new java.util.TreeMap<Integer, JSONObject>());
                }
                JSONObject slice = new JSONObject();
                slice.put("order", st.optInt("order"));
                slice.put("name", st.optString("name"));
                slice.put("etaSeconds", bus.optInt("etaSeconds", -1));
                slice.put("arrivalAt", bus.opt("arrivalAt"));
                times.get(key).put(st.optInt("order"), slice);
            }
        }

        int terminusOrder = all.optJSONObject(all.length() - 1).optInt("order", 0);
        int queriedFrom = targets.get(0).optInt("order", 0);
        int queriedTo = targets.get(targets.size() - 1).optInt("order", 0);

        List<JSONObject> busList = new ArrayList<>(buses.values());
        java.util.Collections.sort(busList, new Comparator<JSONObject>() {
            @Override public int compare(JSONObject a, JSONObject b) {
                return Integer.compare(b.optInt("order"), a.optInt("order"));
            }
        });
        JSONArray busesOut = new JSONArray();
        for (JSONObject meta : busList) {
            JSONObject item = new JSONObject(meta.toString());
            int busOrder = meta.optInt("order");
            java.util.TreeMap<Integer, JSONObject> map = times.get(meta.optString("busId"));
            JSONArray slices = new JSONArray();
            for (JSONObject st : targets) {
                int order = st.optInt("order");
                JSONObject slice = map == null ? null : map.get(order);
                if (slice == null) {
                    slice = new JSONObject();
                    slice.put("order", order);
                    slice.put("name", st.optString("name"));
                    slice.put("etaSeconds", JSONObject.NULL);
                    slice.put("arrivalAt", JSONObject.NULL);
                }
                slice.put("passed", order < busOrder);
                slices.put(slice);
            }
            item.put("times", slices);
            item.put("stationsAway", Math.max(0, fromOrder - busOrder));
            item.put("stationsToEnd", Math.max(0, terminusOrder - busOrder));
            item.put("passedSelected", busOrder > fromOrder);
            item.put("terminusOrder", terminusOrder);
            busesOut.put(item);
        }

        JSONArray stationsOut = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject st = all.optJSONObject(i);
            stationsOut.put(new JSONObject()
                    .put("order", st.optInt("order"))
                    .put("name", st.optString("name"))
                    .put("stationId", st.optString("stationId"))
                    .put("lat", st.optDouble("lat", 0))
                    .put("lng", st.optDouble("lng", 0))
                    .put("suspended", st.optBoolean("suspended", false))
                    .put("loop", st.optBoolean("loop", false))
                    .put("loopLen", st.optInt("loopLen", 0)));
        }
        JSONObject lineOut = new JSONObject();
        lineOut.put("lineId", detail.optString("lineId"));
        lineOut.put("name", detail.optString("name"));
        lineOut.put("startSn", detail.optString("startSn"));
        lineOut.put("endSn", detail.optString("endSn"));
        lineOut.put("firstTime", detail.optString("firstTime"));
        lineOut.put("lastTime", detail.optString("lastTime"));
        lineOut.put("depDesc", detail.optString("depDesc", ""));
        lineOut.put("depIntervalM", detail.optInt("depIntervalM", -1));
        lineOut.put("departLeft", detail.optLong("departLeft", 0));
        lineOut.put("departRight", detail.optLong("departRight", 0));
        lineOut.put("intervalLeft", detail.optInt("intervalLeft", -1));
        lineOut.put("intervalRight", detail.optInt("intervalRight", -1));
        lineOut.put("preArrivalTime", detail.optString("preArrivalTime", ""));

        JSONObject out = new JSONObject();
        out.put("line", lineOut);
        out.put("stations", stationsOut);
        out.put("buses", busesOut);
        out.put("queriedFrom", queriedFrom);
        out.put("queriedTo", queriedTo);
        return out;
    }

    /** 从 neartext / busToStationTips 里抠站数，如「3站」→ 3。 */
    private static int parseAway(String text) {
        if (text == null) return 0;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\d+)\\s*站").matcher(text);
        if (m.find()) {
            try { return Integer.parseInt(m.group(1)); } catch (Exception ignored) {}
        }
        return 0;
    }

    /** 从 neartext 里抠分钟数，如「5分钟」→ 300 秒。 */
    private static int parseEta(String text) {
        if (text == null) return -1;
        if (text.contains("即将到站")) return 0;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\d+)\\s*分钟").matcher(text);
        if (m.find()) {
            try { return Integer.parseInt(m.group(1)) * 60; } catch (Exception ignored) {}
        }
        return -1;
    }

    private JSONObject byStation(String cmd, String stationName) throws Exception {
        JSONObject p = base(cmd);
        p.put("STATIONNAME", stationName);
        p.put("MYLAT", "");
        p.put("MYLNG", "");
        return p;
    }

    /** 轻量异常，和普通 Exception 一样往上抛，由 BusBridge 统一转错误。 */
    public static class ApiException extends Exception {
        public ApiException(String msg) { super(msg); }
    }
}
