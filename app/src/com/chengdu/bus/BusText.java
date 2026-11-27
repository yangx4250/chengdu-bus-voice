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

    /** 数字的口语念法：多位数逐位读，个位数照常（1 读「一」，多位数里的 1 读「幺」）。 */
    private static final String[] DIGIT_SPEECH = {
            "零", "幺", "二", "三", "四", "五", "六", "七", "八", "九"
    };

    /** 把一串字符里的数字换成播报念法：716 → 七幺六，39A → 三九A。 */
    public static String speakDigits(String value) {
        if (value == null || value.isEmpty()) return "";
        StringBuilder out = new StringBuilder(value.length() + 6);
        int i = 0;
        while (i < value.length()) {
            char ch = value.charAt(i);
            if (ch < '0' || ch > '9') { out.append(ch); i++; continue; }
            int j = i;
            while (j < value.length() && value.charAt(j) >= '0' && value.charAt(j) <= '9') j++;
            String run = value.substring(i, j);
            if (run.length() == 1) out.append(run.charAt(0) == '1' ? "一" : DIGIT_SPEECH[run.charAt(0) - '0']);
            else for (int k = 0; k < run.length(); k++) out.append(DIGIT_SPEECH[run.charAt(k) - '0']);
            i = j;
        }
        return out.toString();
    }

    /** 播报里念的线路名：先按 lineLabel 补「路」，再把数字换成口语念法。 */
    public static String lineSpeech(String lineName) {
        return speakDigits(lineLabel(lineName));
    }

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
