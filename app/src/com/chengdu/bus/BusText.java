package com.chengdu.bus;

/**
 * 播报文案里的小工具。
 *
 * 四川各地线路命名不统一：成都 `16`、自贡 `1路`、泸州 `酒城快线D1`、
 * 绵阳 `1001M（社区巴士）`、都江堰 `都江堰1`。以前到处直接拼「路」，
 * 会念出「1001M（社区巴士）路」「酒城快线D1路」这种怪话。
 *
 * 规则：**纯数字**后面补「路」，其它原样。与 lib/announce.mjs 的 lineLabel 一致。
 */
public final class BusText {

    private BusText() {}

    /** 线路名的可读写法。 */
    public static String lineLabel(String lineName) {
        if (lineName == null) return "公交";
        String name = lineName.trim();
        if (name.isEmpty()) return "公交";
        for (int i = 0; i < name.length(); i++) {
            char ch = name.charAt(i);
            if (ch < '0' || ch > '9') return name;   // 含非数字 → 原样
        }
        return name + "路";
    }
}
