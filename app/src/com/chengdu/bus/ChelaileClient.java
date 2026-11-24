package com.chengdu.bus;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;

/**
 * 车来了小程序接口（只查成都）。
 *
 * 签名 cryptoSign = md5(`"k"="v"&…` + "qwihrnbtmj")
 * 返回体 encryptResult = base64(AES-256-ECB(json))
 */
public final class ChelaileClient {

    public static final String CITY_ID = "007";
    public static final String CITY_NAME = "成都";
    public static final String AREA_PREFIX = "028";
    /** 支持的城市：成都（含区县）与都江堰。都江堰在车来了里有独立 cityId 271，但数据与 007 互通。 */
    private static final String[][] SUPPORTED = { {"007", "成都"}, {"271", "都江堰"} };

    private static final String BASE = "https://web.chelaile.net.cn/api/bus/";
    /** 换乘规划在独立的 /api/transfer/ 路径下，签名协议相同但路径不同。 */
    private static final String TRANSIT_BASE = "https://web.chelaile.net.cn/api/transfer/";
    private static final String SALT = "qwihrnbtmj";
    private static final String AES_KEY = "FF32AE65FBFD19414EAAFF6291A54B42";
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
            + "Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) "
            + "NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) "
            + "UnifiedPCWindowsWechat(0xf254160a) XWEB/18055";

    private static final LinkedHashMap<String, String> BASE_PARAMS = new LinkedHashMap<>();
    static {
        BASE_PARAMS.put("s", "h5");
        BASE_PARAMS.put("wxs", "wx_app");
        BASE_PARAMS.put("sign", "1");
        BASE_PARAMS.put("h5RealData", "1");
        BASE_PARAMS.put("v", "3.11.28");
        BASE_PARAMS.put("src", "weixinapp_cx");
        BASE_PARAMS.put("ctm_mp", "mp_wx");
        BASE_PARAMS.put("vc", "2");
        BASE_PARAMS.put("favoriteGray", "1");
        BASE_PARAMS.put("gpstype", "wgs");
        BASE_PARAMS.put("geo_type", "wgs");
        BASE_PARAMS.put("scene", "1256");
    }

    public static final class ApiException extends Exception {
        ApiException(String message) { super(message); }
    }

    // ---------------------------------------------------------------- 接口

    /** 坐标是否在支持范围内（成都 / 都江堰）；不是就抛异常。 */
    public JSONObject assertChengdu(double lat, double lng) throws Exception {
        String url = "https://web.chelaile.net.cn/cdatasource/citylist"
                + "?type=gpsRealtimeCity&lat=" + lat + "&lng=" + lng
                + "&gpstype=wgs&s=android&v=3.80.0&src=webapp_default";
        JSONObject root = new JSONObject(httpGet(url));
        JSONObject city = root.optJSONObject("data") == null
                ? null : root.getJSONObject("data").optJSONObject("gpsRealtimeCity");
        if (city == null) throw new ApiException("城市定位服务不可用");
        String cityId = city.optString("cityId");
        String cityName = city.optString("cityName");
        String matched = null;
        for (String[] entry : SUPPORTED) {
            if (entry[0].equals(cityId) || entry[1].equals(cityName)) { matched = entry[1]; break; }
        }
        if (matched == null) {
            throw new ApiException("当前位置属于「" + cityName + "」，本 App 目前只支持成都（含都江堰）");
        }
        JSONObject out = new JSONObject();
        out.put("cityId", cityId);
        out.put("city", matched);
        return out;
    }

    /** 线路搜索，过滤掉地铁和非 028 线路。 */
    public JSONArray searchLines(String keyword) throws Exception {
        LinkedHashMap<String, String> extra = new LinkedHashMap<>();
        extra.put("key", keyword);
        extra.put("supportPhyStn", "true");
        JSONObject data = call("query!nSearch.action", extra);
        JSONArray lines = data.optJSONObject("result") == null
                ? new JSONArray() : data.getJSONObject("result").optJSONArray("lines");
        JSONArray out = new JSONArray();
        if (lines == null) return out;
        for (int i = 0; i < lines.length(); i++) {
            JSONObject line = lines.getJSONObject(i);
            if (line.optInt("subwayV2", 0) == 1) continue;
            String lineId = line.optString("lineId");
            String lineName = line.optString("name");
            if (lineName != null && lineName.startsWith("地铁")) continue;
            JSONObject item = new JSONObject();
            item.put("lineId", lineId);
            item.put("name", line.optString("name"));
            item.put("direction", line.optInt("direction"));
            item.put("startSn", line.optString("startSn"));
            item.put("endSn", line.optString("endSn"));
            item.put("firstTime", line.optString("firstTime"));
            item.put("lastTime", line.optString("lastTime"));
            out.put(item);
        }
        return out;
    }

    /** 站点搜索：query!nSearch 的 result.stations（服务端最多给 3 条）。 */
    public JSONArray searchStations(String keyword) throws Exception {
        LinkedHashMap<String, String> extra = new LinkedHashMap<>();
        extra.put("key", keyword);
        extra.put("supportPhyStn", "true");
        JSONObject data = call("query!nSearch.action", extra);
        JSONObject result = data.optJSONObject("result");
        JSONArray out = new JSONArray();
        if (result == null) return out;
        JSONArray stations = result.optJSONArray("stations");
        if (stations == null) return out;
        for (int i = 0; i < stations.length(); i++) {
            JSONObject st = stations.getJSONObject(i);
            String name = st.optString("sn");
            if (name == null || name.length() == 0) continue;
            if (st.optInt("subwayV2", 0) == 1) continue;
            JSONObject item = new JSONObject();
            item.put("stationId", st.optString("sId"));
            item.put("name", name);
            item.put("lat", st.optDouble("lat", 0));
            item.put("lng", st.optDouble("lng", 0));
            item.put("distance", st.optDouble("distance", 0));
            out.put(item);
        }
        return out;
    }

    /** 目的地（POI）搜索：query!nSearch 的 result.pois（服务端最多给 3 条）。
     *  POI 名称在 sn / sn1，坐标是 GCJ-02。 */
    public JSONArray searchPois(String keyword) throws Exception {
        LinkedHashMap<String, String> extra = new LinkedHashMap<>();
        extra.put("key", keyword);
        extra.put("supportPhyStn", "true");
        JSONObject data = call("query!nSearch.action", extra);
        JSONObject result = data.optJSONObject("result");
        JSONArray out = new JSONArray();
        if (result == null) return out;
        JSONArray pois = result.optJSONArray("pois");
        if (pois == null) return out;
        for (int i = 0; i < pois.length(); i++) {
            JSONObject p = pois.getJSONObject(i);
            String name = p.optString("sn1");
            if (name == null || name.length() == 0) name = p.optString("sn");
            if (name == null || name.length() == 0) continue;
            JSONObject item = new JSONObject();
            item.put("name", name);
            item.put("address", p.optString("sn1Address", p.optString("address", "")));
            item.put("lat", p.optDouble("lat", 0));
            item.put("lng", p.optDouble("lng", 0));
            out.put(item);
        }
        return out;
    }

    /** 公交/地铁换乘规划。起点是 WGS84（state.fix），内部转 GCJ-02；终点已是 GCJ-02。
     *  返回 { transits:[{ duration,walkingDistance,transferCount,tag,
     *                     segments:[{mode,name,lineId,lineType,from,to,viaNum,duration,walkDistance}] }] }
     *  公交段 lineId 可直接进详情页；地铁段 lineId 为空、只有 name。 */
    public JSONObject transit(double fromLat, double fromLng, String fromName,
                              double destLat, double destLng, String destName,
                              String strategy) throws Exception {
        // 起点 WGS84 → GCJ-02（换乘接口要求 gcj），终点 POI 已是 GCJ
        double[] fromGcj = Geo.wgsToGcj(fromLat, fromLng);
        LinkedHashMap<String, String> extra = new LinkedHashMap<>();
        extra.put("origin_name", fromName == null ? "我的位置" : fromName);
        extra.put("origin_lat", fmt(fromGcj[0]));
        extra.put("origin_lng", fmt(fromGcj[1]));
        extra.put("dest_name", destName == null ? "目的地" : destName);
        extra.put("dest_lat", fmt(destLat));
        extra.put("dest_lng", fmt(destLng));
        extra.put("gpstype", "gcj");
        extra.put("geo_type", "gcj");
        extra.put("strategy", strategy == null ? "0" : strategy);
        extra.put("isSelectTime", "0");
        extra.put("departure_time", String.valueOf(System.currentTimeMillis()));

        JSONObject data = call(TRANSIT_BASE, "transit!integrate.action", extra);
        JSONObject route = data.optJSONObject("route");
        JSONArray out = new JSONArray();
        if (route != null) {
            JSONArray transits = route.optJSONArray("transits");
            if (transits != null) {
                for (int t = 0; t < transits.length(); t++) {
                    JSONObject tr = transits.getJSONObject(t);
                    JSONObject plan = new JSONObject();
                    plan.put("duration", tr.optInt("duration", 0));
                    plan.put("walkingDistance", tr.optInt("walking_distance", 0));
                    plan.put("transferCount", tr.optInt("cc", 0));
                    plan.put("tag", tr.optString("tag", ""));
                    JSONArray segsOut = new JSONArray();
                    JSONArray segs = tr.optJSONArray("segments");
                    if (segs != null) {
                        for (int s = 0; s < segs.length(); s++) {
                            JSONObject seg = segs.getJSONObject(s);
                            // 步行段（进入站台/出站到目的地）
                            JSONObject walk = seg.optJSONObject("walking");
                            if (walk == null) walk = seg.optJSONObject("walk");
                            if (walk != null) {
                                int wd = walk.optInt("distance", 0);
                                if (wd > 0) {
                                    JSONObject ws = new JSONObject();
                                    ws.put("mode", "walk");
                                    ws.put("walkDistance", wd);
                                    segsOut.put(ws);
                                }
                            }
                            // 乘车段（公交 / 地铁）
                            JSONObject bus = seg.optJSONObject("bus");
                            if (bus != null) {
                                JSONArray lines = bus.optJSONArray("buslines");
                                if (lines != null && lines.length() > 0) {
                                    JSONObject ln = lines.getJSONObject(0);
                                    JSONObject rs = new JSONObject();
                                    int lineType = ln.optInt("lineType", 0);
                                    rs.put("mode", lineType == 1 ? "metro" : "bus");
                                    rs.put("name", ln.optString("name", ""));
                                    rs.put("lineId", ln.optString("lineId", ""));
                                    rs.put("lineType", lineType);
                                    JSONObject from = ln.optJSONObject("departure_stop");
                                    JSONObject to = ln.optJSONObject("arrival_stop");
                                    rs.put("from", from == null ? "" : from.optString("name", ""));
                                    rs.put("to", to == null ? "" : to.optString("name", ""));
                                    rs.put("viaNum", ln.optInt("via_num", 0));
                                    rs.put("duration", ln.optInt("duration", 0));
                                    segsOut.put(rs);
                                }
                            }
                        }
                    }
                    plan.put("segments", segsOut);
                    out.put(plan);
                }
            }
        }
        JSONObject result = new JSONObject();
        result.put("transits", out);
        return result;
    }

    private static String fmt(double v) {
        return String.format(java.util.Locale.US, "%.6f", v);
    }

    /** 线路详情 + 站点表。 */
    public JSONObject lineDetail(String lineId) throws Exception {
        LinkedHashMap<String, String> extra = new LinkedHashMap<>();
        extra.put("lineId", lineId);
        extra.put("lat", "");
        extra.put("lng", "");
        extra.put("geo_lat", "");
        extra.put("geo_lng", "");
        JSONObject data = call("line!encryptedLineDetail.action", extra);

        JSONObject line = data.optJSONObject("line") == null ? new JSONObject() : data.getJSONObject("line");
        JSONArray stations = data.optJSONArray("stations");
        JSONArray outStations = new JSONArray();
        if (stations != null) {
            for (int i = 0; i < stations.length(); i++) {
                JSONObject st = stations.getJSONObject(i);
                JSONObject item = new JSONObject();
                item.put("stationId", st.optString("sId"));
                item.put("order", st.optInt("order"));
                item.put("name", st.optString("sn"));
                item.put("lat", st.optDouble("wgsLat"));
                item.put("lng", st.optDouble("wgsLng"));
                outStations.put(item);
            }
        }
        JSONObject out = new JSONObject();
        out.put("lineId", line.optString("lineId", lineId));
        out.put("name", line.optString("name"));
        out.put("startSn", line.optString("startSn"));
        out.put("endSn", line.optString("endSn"));
        out.put("firstTime", line.optString("firstTime"));
        out.put("lastTime", line.optString("lastTime"));
        out.put("price", line.optString("price"));
        out.put("depDesc", data.optString("depDesc", ""));
        out.put("depIntervalM", data.optInt("depIntervalM", -1));
        out.put("departLeft", data.optLong("departLeft", 0));
        out.put("departRight", data.optLong("departRight", 0));
        out.put("intervalLeft", data.optInt("intervalLeft", -1));
        out.put("intervalRight", data.optInt("intervalRight", -1));
        out.put("preArrivalTime", data.optString("preArrivalTime", ""));
        out.put("stations", outStations);
        return out;
    }

    /** 指定线路 + 站点的实时到站。 */
    public JSONArray arrivals(String lineId, JSONObject station) throws Exception {
        int order = station.getInt("order");
        LinkedHashMap<String, String> extra = new LinkedHashMap<>();
        extra.put("cshow", "busDetail");
        extra.put("specail", "0");
        extra.put("specialType", "undefined");
        extra.put("lineId", lineId);
        extra.put("targetOrder", String.valueOf(order));
        extra.put("specialTargetOrder", String.valueOf(order));
        extra.put("stationId", station.optString("stationId"));
        String lat = String.valueOf(station.optDouble("lat", 0));
        String lng = String.valueOf(station.optDouble("lng", 0));
        extra.put("lat", lat);
        extra.put("lng", lng);
        extra.put("geo_lat", lat);
        extra.put("geo_lng", lng);
        extra.put("userId", "");
        extra.put("h5Id", "");
        extra.put("unionId", "");
        extra.put("accountId", "");
        extra.put("secret", "");

        JSONObject data = call("line!encryptedBusDetail.action", extra);
        JSONArray buses = data.optJSONArray("buses");
        JSONArray out = new JSONArray();
        if (buses == null) return out;

        List<JSONObject> list = new ArrayList<>();
        for (int i = 0; i < buses.length(); i++) {
            JSONObject bus = buses.getJSONObject(i);
            double distance = bus.optDouble("distanceToWaitStn", -1);
            if (distance < 0) continue; // 已过站
            int busOrder = bus.optInt("order", 0);
            JSONObject travel = new JSONObject();
            JSONArray travels = bus.optJSONArray("travels");
            if (travels != null && travels.length() > 0) travel = travels.getJSONObject(0);

            JSONObject item = new JSONObject();
            item.put("busId", bus.optString("busId"));
            item.put("plate", bus.optString("licence"));
            item.put("order", busOrder);
            item.put("stationsAway", Math.max(0, order - busOrder));
            item.put("distanceMeters", Math.round(distance));
            int eta = travel.optInt("travelTime", -1);
            item.put("etaSeconds", eta > 0 ? eta : JSONObject.NULL);
            item.put("arrivalAt", travel.has("arrivalTime") ? travel.optLong("arrivalTime") : JSONObject.NULL);
            list.add(item);
        }
        java.util.Collections.sort(list, new java.util.Comparator<JSONObject>() {
            @Override
            public int compare(JSONObject a, JSONObject b) {
                return Integer.compare(a.optInt("stationsAway"), b.optInt("stationsAway"));
            }
        });
        for (JSONObject item : list) out.put(item);
        return out;
    }

    /** 附近站点 + 各线路最近一辆车的到站。 */
    public JSONObject nearby(double lat, double lng, int limit) throws Exception {
        LinkedHashMap<String, String> extra = new LinkedHashMap<>();
        extra.put("type", "1");
        extra.put("act", "2");
        extra.put("lat", String.valueOf(lat));
        extra.put("lng", String.valueOf(lng));
        extra.put("geo_lat", String.valueOf(lat));
        extra.put("geo_lng", String.valueOf(lng));
        JSONObject data = call("stop!homePageInfo.action", extra);

        JSONArray lines = data.optJSONArray("lines");
        JSONArray arrivals = new JSONArray();
        if (lines != null) {
            for (int i = 0; i < lines.length(); i++) {
                JSONObject entry = lines.getJSONObject(i);
                JSONObject target = entry.optJSONObject("targetStation");
                JSONObject state = entry.optJSONObject("stnState");
                if (target == null || state == null) continue;
                int stationsAway = Math.max(0, target.optInt("order", 0) - state.optInt("order", 0));
                JSONObject item = new JSONObject();
                item.put("stationId", target.optString("sId"));
                item.put("stationName", target.optString("sn"));
                item.put("stationOrder", target.optInt("order", 0));
                JSONObject line = entry.optJSONObject("line");
                item.put("lineId", line == null ? "" : line.optString("lineId"));
                item.put("lineName", line == null ? "" : line.optString("name"));
                item.put("firstTime", line == null ? "" : line.optString("firstTime"));
                item.put("lastTime", line == null ? "" : line.optString("lastTime"));
                item.put("preStartTime", entry.optString("preStartTime", ""));
                item.put("preArrivalTime", entry.optString("preArrivalTime", ""));
                item.put("toward", line == null ? "" : line.optString("endSn"));
                item.put("stationsAway", stationsAway);
                int eta = state.optInt("travelTime", -1);
                item.put("etaSeconds", eta > 0 ? eta : JSONObject.NULL);
                item.put("arrived", stationsAway == 0);
                arrivals.put(item);
            }
        }

        JSONArray nearSts = data.optJSONArray("nearSts");
        JSONArray stops = new JSONArray();
        if (nearSts != null) {
            for (int i = 0; i < nearSts.length() && i < limit; i++) {
                JSONObject st = nearSts.getJSONObject(i);
                JSONObject stop = new JSONObject();
                stop.put("stationId", st.optString("sId"));
                stop.put("name", st.optString("sn"));
                stop.put("distanceMeters", st.optInt("distance"));
                stop.put("lineNames", st.optString("lineNames"));
                /* 该站全部线路名（含没有实时数据的那几条）：
                   首页三列网格要靠它把「这个站的所有线路」都列出来。 */
                JSONArray nameList = st.optJSONArray("lineNameList");
                JSONArray names = new JSONArray();
                if (nameList != null) {
                    for (int q = 0; q < nameList.length(); q++) names.put(nameList.optString(q));
                }
                /* 站点经纬度：首页的 🧭 导航按钮要用（没有就点不了） */
                stop.put("lat", st.optDouble("lat", 0));
                stop.put("lng", st.optDouble("lng", 0));
                JSONArray own = new JSONArray();
                for (int k = 0; k < arrivals.length(); k++) {
                    JSONObject a = arrivals.getJSONObject(k);
                    if (st.optString("sId").equals(a.optString("stationId"))) own.put(a);
                }
                stop.put("arrivals", own);
                stop.put("lineNameList", names);
                stops.put(stop);
            }
        }
        JSONObject out = new JSONObject();
        out.put("stops", stops);
        out.put("allArrivals", arrivals);
        return out;
    }

    /**
     * 单车逐站时间矩阵。
     *
     * 接口只给「某站即将到站的车」，不直接给某辆车到后续各站的时间；
     * 所以对 fromOrder 之后的每一站分别查一次，再按 busId 把同一辆车串起来。
     * window 控制往后看几站（每站一次请求，4 路并发）。
     */
    public JSONObject stationMatrix(String lineId, int fromOrder, int window) throws Exception {
        JSONObject detail = lineDetail(lineId);
        JSONArray allStations = detail.getJSONArray("stations");

        // 先探一次「你点的这一站」，看车已经开到哪了：
        // 窗口要以车的位置为起点，而不是以你点的那站为起点，
        // 否则点终点站就等于只能看到终点站。
        int startOrder = fromOrder;
        JSONObject probeStation = null;
        for (int i = 0; i < allStations.length(); i++) {
            JSONObject station = allStations.getJSONObject(i);
            if (station.getInt("order") == fromOrder) { probeStation = station; break; }
        }
        if (probeStation != null) {
            try {
                JSONArray probe = arrivals(lineId, probeStation);
                for (int i = 0; i < probe.length(); i++) {
                    int busOrder = probe.getJSONObject(i).optInt("order", Integer.MAX_VALUE);
                    if (busOrder > 0) startOrder = Math.min(startOrder, busOrder);
                }
            } catch (Exception ignored) {
                // 探测失败就退回用你点的站
            }
        }
        startOrder = Math.max(1, startOrder);

        final int windowStart = startOrder;
        List<JSONObject> targets = new ArrayList<>();
        for (int i = 0; i < allStations.length() && targets.size() < window; i++) {
            JSONObject station = allStations.getJSONObject(i);
            if (station.getInt("order") >= windowStart) targets.add(station);
        }
        if (targets.isEmpty()) throw new ApiException("这条线路上没有可查询的站点");

        ExecutorService pool = Executors.newFixedThreadPool(Math.min(6, targets.size()));
        List<Future<JSONArray>> futures = new ArrayList<>();
        for (final JSONObject station : targets) {
            futures.add(pool.submit(new Callable<JSONArray>() {
                @Override
                public JSONArray call() throws Exception {
                    return arrivals(lineId, station);
                }
            }));
        }

        // busId → (stationOrder → 该车在这一站的到站信息)
        LinkedHashMap<String, JSONObject> buses = new LinkedHashMap<>();
        LinkedHashMap<String, TreeMap<Integer, JSONObject>> times = new LinkedHashMap<>();

        for (int i = 0; i < futures.size(); i++) {
            JSONObject station = targets.get(i);
            JSONArray busesAtStation;
            try {
                busesAtStation = futures.get(i).get();
            } catch (Exception e) {
                continue; // 单站失败不影响整体
            }
            for (int k = 0; k < busesAtStation.length(); k++) {
                JSONObject bus = busesAtStation.getJSONObject(k);
                String key = bus.optString("busId", "");
                if (key.isEmpty()) key = "order-" + bus.optInt("order");
                if (!buses.containsKey(key)) {
                    JSONObject meta = new JSONObject();
                    meta.put("busId", key);
                    meta.put("plate", bus.optString("plate"));
                    meta.put("order", bus.optInt("order"));
                    buses.put(key, meta);
                    times.put(key, new TreeMap<Integer, JSONObject>());
                }
                JSONObject slice = new JSONObject();
                slice.put("order", station.getInt("order"));
                slice.put("name", station.getString("name"));
                slice.put("etaSeconds", bus.optInt("etaSeconds", -1));
                slice.put("arrivalAt", bus.opt("arrivalAt"));
                times.get(key).put(station.getInt("order"), slice);
            }
        }
        pool.shutdown();

        JSONArray stationsOut = new JSONArray();
        for (int i = 0; i < allStations.length(); i++) {
            JSONObject station = allStations.getJSONObject(i);
            stationsOut.put(new JSONObject()
                    .put("order", station.getInt("order"))
                    .put("name", station.getString("name"))
                    .put("stationId", station.optString("stationId"))
                    .put("lat", station.optDouble("lat", 0))
                    .put("lng", station.optDouble("lng", 0)));
        }
        int terminusOrder = allStations.getJSONObject(allStations.length() - 1).getInt("order");
        int queriedFrom = targets.get(0).getInt("order");
        int queriedTo = targets.get(targets.size() - 1).getInt("order");

        List<JSONObject> busList = new ArrayList<>(buses.values());
        // 车序小的（离起点近、刚过站）排在后面，离当前站最近的排前面
        Collections.sort(busList, new Comparator<JSONObject>() {
            @Override
            public int compare(JSONObject a, JSONObject b) {
                return Integer.compare(b.optInt("order"), a.optInt("order"));
            }
        });

        JSONArray busesOut = new JSONArray();
        for (JSONObject meta : busList) {
            JSONObject item = new JSONObject(meta.toString());
            int busOrder = meta.optInt("order");
            JSONArray slices = new JSONArray();
            TreeMap<Integer, JSONObject> map = times.get(meta.getString("busId"));
            for (JSONObject station : targets) {
                int order = station.getInt("order");
                JSONObject slice = map.get(order);
                if (slice == null) {
                    slice = new JSONObject()
                            .put("order", order)
                            .put("name", station.getString("name"))
                            .put("etaSeconds", JSONObject.NULL)
                            .put("arrivalAt", JSONObject.NULL);
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

    // ---------------------------------------------------------------- 协议底层

    private JSONObject call(String endpoint, LinkedHashMap<String, String> extra) throws Exception {
        return call(BASE, endpoint, extra);
    }

    /** 支持自定义域名前缀（换乘规划在 /api/transfer/ 下）。 */
    private JSONObject call(String base, String endpoint, LinkedHashMap<String, String> extra) throws Exception {
        LinkedHashMap<String, String> params = new LinkedHashMap<>(BASE_PARAMS);
        params.put("cityId", CITY_ID);
        params.put("localCityId", CITY_ID);
        if (extra != null) params.putAll(extra);
        params.put("cryptoSign", sign(params));

        String raw = httpGet(base + endpoint + "?" + buildQuery(params));
        JSONObject envelope = extractJson(raw);
        JSONObject jsonr = envelope.optJSONObject("jsonr");
        if (jsonr == null) throw new ApiException("接口返回异常");
        String status = jsonr.optString("status", "");
        if (!status.isEmpty() && !"00".equals(status) && !"0".equals(status) && !"0000".equals(status)) {
            throw new ApiException(jsonr.optString("errmsg", "接口状态 " + status));
        }
        JSONObject data = jsonr.optJSONObject("data");
        if (data == null) return new JSONObject();
        String encrypted = data.optString("encryptResult", "");
        if (!encrypted.isEmpty()) return new JSONObject(decrypt(encrypted));
        return data;
    }

    private static String buildQuery(LinkedHashMap<String, String> params) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> entry : params.entrySet()) {
            if (sb.length() > 0) sb.append('&');
            sb.append(URLEncoder.encode(entry.getKey(), "UTF-8"));
            sb.append('=');
            sb.append(URLEncoder.encode(entry.getValue() == null ? "" : entry.getValue(), "UTF-8"));
        }
        return sb.toString();
    }

    private static String sign(LinkedHashMap<String, String> params) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> entry : params.entrySet()) {
            if (sb.length() > 0) sb.append('&');
            sb.append('"').append(entry.getKey()).append("\"=\"")
              .append(entry.getValue() == null ? "" : entry.getValue()).append('"');
        }
        sb.append(SALT);
        MessageDigest md5 = MessageDigest.getInstance("MD5");
        byte[] digest = md5.digest(sb.toString().getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : digest) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    private static String decrypt(String base64) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/ECB/PKCS5Padding");
        SecretKeySpec key = new SecretKeySpec(AES_KEY.getBytes(StandardCharsets.UTF_8), "AES");
        cipher.init(Cipher.DECRYPT_MODE, key);
        byte[] plain = cipher.doFinal(Base64.getDecoder().decode(base64));
        return new String(plain, StandardCharsets.UTF_8);
    }

    /** 响应外层有 **YGKJ…YGKJ## 广告前缀，取第一个完整 JSON。 */
    private static JSONObject extractJson(String raw) throws Exception {
        int start = raw.indexOf('{');
        if (start < 0) throw new ApiException("响应不是 JSON：" + raw.substring(0, Math.min(80, raw.length())));
        int depth = 0;
        for (int i = start; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            if (ch == '{') depth++;
            else if (ch == '}') {
                depth--;
                if (depth == 0) return new JSONObject(raw.substring(start, i + 1));
            }
        }
        throw new ApiException("响应 JSON 被截断");
    }

    private static String httpGet(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(12000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("User-Agent", UA);
        conn.setRequestProperty("xweb_xhr", "1");
        conn.setRequestProperty("Content-Type", "text");
        conn.setRequestProperty("Accept", "*/*");
        conn.setRequestProperty("Referer", "https://servicewechat.com/wx71d589ea01ce3321/814/page-frame.html");
        conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
        int code = conn.getResponseCode();
        InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (stream == null) throw new ApiException("HTTP " + code);
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = stream.read(chunk)) > 0) buffer.write(chunk, 0, read);
        stream.close();
        conn.disconnect();
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }
}