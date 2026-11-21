#!/usr/bin/env python3
"""把 APK 里「未压缩条目」的数据起点对齐到 4 字节 —— 相当于 zipalign。

做法：在需要的条目之前插入填充字节（中央目录里的偏移量会同步更新），
这样 libziparchive 按偏移直读仍然正常，而 mmap 对齐要求也满足。
"""
import struct
import sys
import zipfile
import zlib


def align(src: str, dst: str, alignment: int = 4) -> None:
    zin = zipfile.ZipFile(src)
    entries = []
    for info in zin.infolist():
        data = zin.read(info.filename)
        method = info.compress_type
        if method == zipfile.ZIP_DEFLATED:
            compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
            payload = compressor.compress(data) + compressor.flush()
        elif method == zipfile.ZIP_STORED:
            payload = data
        else:
            raise SystemExit(f"不支持的压缩方式 {method}: {info.filename}")
        entries.append((info, data, payload, method))

    out = open(dst, "wb")
    central = []
    for info, data, payload, method in entries:
        name = info.filename.encode("utf-8")
        header_size = 30 + len(name)
        if method == zipfile.ZIP_STORED:
            pad = (-(out.tell() + header_size)) % alignment
            if pad:
                out.write(b"\x00" * pad)
        offset = out.tell()
        crc = zlib.crc32(data) & 0xFFFFFFFF
        flags = info.flag_bits & ~0x0008
        out.write(struct.pack(
            "<IHHHHHIIIHH",
            0x04034B50, 20, flags, method,
            info.date_time[1] << 5 | info.date_time[2],
            (info.date_time[0] - 1980) << 9 | info.date_time[3] << 5 | info.date_time[4] // 2,
            crc, len(payload), len(data), len(name), 0,
        ))
        out.write(name)
        out.write(payload)
        central.append((name, info, method, crc, offset, len(payload), len(data), flags))

    central_start = out.tell()
    for name, info, method, crc, offset, csize, usize, flags in central:
        out.write(struct.pack(
            "<IHHHHHHIIIHHHHHII",
            0x02014B50, 20, 20, flags, method,
            info.date_time[1] << 5 | info.date_time[2],
            (info.date_time[0] - 1980) << 9 | info.date_time[3] << 5 | info.date_time[4] // 2,
            crc, csize, usize, len(name), 0, 0, 0, 0, 0, offset,
        ))
        out.write(name)
    central_end = out.tell()
    out.write(struct.pack(
        "<IHHHHIIH",
        0x06054B50, 0, 0, len(central), len(central),
        central_end - central_start, central_start, 0,
    ))
    out.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("用法: zipalign.py <in.apk> <out.apk>")
        raise SystemExit(1)
    align(sys.argv[1], sys.argv[2])
    print("aligned:", sys.argv[2])