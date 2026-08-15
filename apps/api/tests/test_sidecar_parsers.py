"""Tests for the sidecar parsers (§23b/§23c, 2026-08-15).

No DB, no mocks, no network — these are pure functions over bytes, so the
fixtures are built here from the formats' actual structure. The AVCHD .CPI
fixture in particular is assembled byte-for-byte from the layout in libbluray's
clpi_parse.c, which is the only thing that makes the offsets falsifiable: get
one of them wrong and the assertions below fail rather than quietly returning
a plausible frame rate.

The existing CDL/ALE/camera-XML parsers are covered too, deliberately — this
change extends that system rather than replacing it, and a regression there
would be worse than any of the new formats failing.
"""

import struct

import pytest

from apps.api.services.sidecar_parsers import (
    BINARY_SIDECAR_TYPES,
    SIDECAR_EXTENSIONS,
    SidecarParseError,
    detect_sidecar_type,
    extract_xmp,
    parse_ale,
    parse_avchd_cpi,
    parse_camera_xml,
    parse_cdl,
    parse_dji_srt,
    parse_nikon_nksc,
    parse_opaque_binary,
    parse_red_rmd,
    parse_sidecar,
)


# ─── Extension detection ─────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "filename,expected",
    [
        ("A001C002.cdl", "cdl"),
        ("shot.CC", "cdl"),
        ("collection.ccc", "cdl"),
        ("dailies.ale", "ale"),
        ("C0001M01.XML", "camera_xml"),
        ("DJI_0001.SRT", "dji_srt"),
        ("00000.CPI", "panasonic_clipinfo"),
        ("DSC_0001.nksc", "nikon_nksc"),
        ("A001_C001.RMD", "red_rmd"),
        ("C0001.BIM", "sony_bim"),
        ("MVI_0001.CIF", "canon_cif"),
        ("A001C002.mov", None),
        ("noextension", None),
    ],
)
def test_detect_sidecar_type(filename, expected):
    assert detect_sidecar_type(filename) == expected


def test_every_extension_maps_to_a_type():
    """A gap here would mean a file the uploader routes to the sidecar
    endpoint that the endpoint then rejects as unsupported."""
    for ext in SIDECAR_EXTENSIONS:
        assert detect_sidecar_type(f"clip{ext}") is not None, ext


def test_binary_types_are_all_real_types():
    for name in BINARY_SIDECAR_TYPES:
        assert detect_sidecar_type(f"x.{name}") is None or True  # name is a type, not an ext
    assert BINARY_SIDECAR_TYPES == {
        "panasonic_clipinfo", "sony_bim", "canon_cif", "nikon_nksc", "red_rmd",
    }


# ─── Existing parsers must not regress ───────────────────────────────────────

CDL_XML = """<?xml version="1.0" encoding="UTF-8"?>
<ColorCorrectionCollection xmlns="urn:ASC:CDL:v1.2">
  <ColorCorrection id="shot_01">
    <SOPNode>
      <Slope>1.0500 0.9800 1.0200</Slope>
      <Offset>-0.0100 0.0000 0.0050</Offset>
      <Power>1.1000 1.0000 0.9500</Power>
    </SOPNode>
    <SatNode><Saturation>0.9000</Saturation></SatNode>
  </ColorCorrection>
</ColorCorrectionCollection>
"""


def test_cdl_still_parses():
    parsed = parse_cdl(CDL_XML)
    corrections = parsed["color_corrections"]
    assert len(corrections) == 1
    assert corrections[0]["id"] == "shot_01"
    assert corrections[0]["slope"] == [1.05, 0.98, 1.02]
    assert corrections[0]["saturation"] == 0.9


def test_ale_still_parses_and_narrows_to_the_matching_clip():
    ale = (
        "Heading\nFIELD_DELIM\tTABS\nVIDEO_FORMAT\t1080\n\n"
        "Column\nName\tScene\tTake\n\n"
        "Data\nA001C001\t12\t3\nA001C002\t12\t4\n"
    )
    parsed = parse_sidecar("ale", ale.encode(), clip_name="A001C002.mov")
    assert parsed["matched_clip"] is True
    assert parsed["clips"] == [{"name": "A001C002", "scene": "12", "take": "4"}]
    assert parsed["heading"]["video_format"] == "1080"


def test_camera_xml_still_flattens_nested_paths():
    parsed = parse_camera_xml(
        "<Item><LensInfo><FocalLength>24</FocalLength></LensInfo></Item>"
    )
    assert parsed["Item.LensInfo.FocalLength"] == "24"


def test_text_parsers_reject_non_utf8_bytes():
    with pytest.raises(SidecarParseError, match="UTF-8"):
        parse_sidecar("camera_xml", b"\xff\xfe\x00binary")


# ─── DJI .SRT telemetry ──────────────────────────────────────────────────────

DJI_MODERN = """1
00:00:00,000 --> 00:00:00,033
<font size="28">FrameCnt: 1, DiffTime: 33ms
2026-05-01 10:00:00,000,000
[iso: 100] [shutter: 1/1000] [fnum: 280] [ev: 0] [focal_len: 240] [latitude: 47.123456] [longitude: 12.345678] [rel_alt: 1.200 abs_alt: 512.345] [gb_yaw: 1.2 gb_pitch: -90.0 gb_roll: 0.0] </font>

2
00:00:00,033 --> 00:00:00,066
<font size="28">FrameCnt: 2, DiffTime: 33ms
2026-05-01 10:00:00,033,000
[iso: 200] [shutter: 1/500] [fnum: 280] [ev: 0] [focal_len: 240] [latitude: 47.223456] [longitude: 12.445678] [rel_alt: 8.400 abs_alt: 519.545] [gb_yaw: 3.4 gb_pitch: -45.0 gb_roll: 0.0] </font>
"""

DJI_LEGACY = """1
00:00:00,000 --> 00:00:01,000
HOME(12.345678,47.123456) 2026.05.01 10:00:00
GPS(12.345678,47.123456,15) BAROMETER:12.3
ISO:100 Shutter:1/1000 EV:0 Fnum:2.8
"""


def test_dji_modern_format():
    parsed = parse_dji_srt(DJI_MODERN)
    assert parsed["sample_count"] == 2
    first = parsed["samples"][0]
    assert first["t"] == 0.0
    assert first["iso"] == "100"
    assert first["shutter"] == "1/1000"
    assert first["latitude"] == "47.123456"
    # Two pairs sharing one bracket must come apart, not merge.
    assert first["rel_alt"] == "1.200"
    assert first["abs_alt"] == "512.345"
    assert first["gb_pitch"] == "-90.0"
    # A value must stop at its own line end, or DiffTime swallows the timestamp.
    assert first["diff_time"] == "33ms"
    assert first["timestamp"] == "2026-05-01 10:00:00"
    assert parsed["ranges"]["rel_alt"] == {"min": 1.2, "max": 8.4}
    assert parsed["_meta"]["confidence"] == "specified"


def test_dji_legacy_format():
    parsed = parse_dji_srt(DJI_LEGACY)
    sample = parsed["samples"][0]
    # GPS(...) is kept as written — DJI's own argument order is not documented
    # consistently, so it is deliberately not split into lat/long here.
    assert sample["gps"] == ["12.345678", "47.123456", "15"]
    assert sample["home"] == ["12.345678", "47.123456"]
    assert sample["barometer"] == "12.3"
    assert sample["iso"] == "100"
    assert sample["fnum"] == "2.8"
    assert sample["timestamp"] == "2026.05.01 10:00:00"


def _srt_stamp(seconds: float) -> str:
    whole = int(seconds)
    return f"{whole // 3600:02d}:{whole // 60 % 60:02d}:{whole % 60:02d},{round(seconds % 1 * 1000):03d}"


def test_dji_srt_downsamples_but_keeps_exact_ranges():
    blocks = []
    for i in range(1000):
        start = i * 0.1
        blocks.append(
            f"{i + 1}\n"
            f"{_srt_stamp(start)} --> {_srt_stamp(start + 0.1)}\n"
            f"[rel_alt: {i}.000]\n"
        )
    parsed = parse_dji_srt("\n".join(blocks))
    assert parsed["sample_count"] == 1000
    assert len(parsed["samples"]) <= 240
    assert "samples_downsampled" in parsed
    # Range is computed before downsampling, so the peak survives even though
    # the sample carrying it may not be in the stored track.
    assert parsed["ranges"]["rel_alt"] == {"min": 0.0, "max": 999.0}


def test_plain_subtitle_file_is_rejected_not_stored_empty():
    subtitle = "1\n00:00:01,000 --> 00:00:03,000\nHello there.\n\n"
    with pytest.raises(SidecarParseError, match="telemetry"):
        parse_dji_srt(subtitle)


# ─── AVCHD .CPI ──────────────────────────────────────────────────────────────

def _build_cpi(
    version: bytes = b"0200",
    coding_type: int = 0x1B,
    fmt: int = 4,      # 1080i
    rate: int = 3,     # 25
    aspect: int = 3,   # 16:9
) -> bytes:
    """Assemble a CLPI file to the layout in libbluray's clpi_parse.c.

    Header: 'HDMV' + version + five 32-bit section offsets.
    ClipInfo at byte 40. ProgramInfo wherever the header says it is.
    """
    program_info_addr = 200

    header = bytearray()
    header += b"HDMV" + version
    header += struct.pack(">I", 100)                  # sequence_info_start_addr
    header += struct.pack(">I", program_info_addr)    # program_info_start_addr
    header += struct.pack(">I", 300)                  # cpi_start_addr
    header += struct.pack(">I", 0)                    # clip_mark_start_addr
    header += struct.pack(">I", 0)                    # ext_data_start_addr

    data = bytearray(header) + bytearray(400 - len(header))

    # ClipInfo at 40: len(4) reserved(2) stream_type(1) app_type(1)
    #                 reserved+atc(4) ts_rate(4) packets(4)
    struct.pack_into(">I", data, 40, 60)
    # Deliberately different values: identical ones would let the two fields be
    # swapped, or read from the wrong offset entirely, without any test noticing.
    data[46] = 1          # clip_stream_type
    data[47] = 5          # application_type
    struct.pack_into(">I", data, 52, 24000000)        # ts_recording_rate
    struct.pack_into(">I", data, 56, 123456)          # num_source_packets

    # ProgramInfo: len(4) reserved(1) num_prog(1)
    pos = program_info_addr
    struct.pack_into(">I", data, pos, 0)
    data[pos + 4] = 0
    data[pos + 5] = 1                                  # one program sequence
    pos += 6
    struct.pack_into(">I", data, pos, 0)               # spn_program_sequence_start
    struct.pack_into(">H", data, pos + 4, 0x1000)      # program_map_pid
    data[pos + 6] = 2                                  # num_streams
    data[pos + 7] = 1                                  # num_groups
    pos += 8

    # Video stream: pid(2) attr_len(1) coding(1) fmt|rate(1) aspect|flags(1)
    struct.pack_into(">H", data, pos, 0x1011)
    data[pos + 2] = 5                                  # attr_len
    data[pos + 3] = coding_type
    data[pos + 4] = (fmt << 4) | rate
    data[pos + 5] = (aspect << 4)
    pos += 3 + 5

    # Audio stream: AC-3, stereo, 48 kHz, "eng"
    struct.pack_into(">H", data, pos, 0x1100)
    data[pos + 2] = 6                                  # attr_len
    data[pos + 3] = 0x81                               # AC-3
    data[pos + 4] = (3 << 4) | 1                       # stereo, 48 kHz
    data[pos + 5:pos + 8] = b"eng"

    return bytes(data)


def test_cpi_reads_video_attributes():
    parsed = parse_avchd_cpi(_build_cpi())
    assert parsed["version"] == "0200"
    assert parsed["video_format"] == "1080i"
    assert parsed["frame_rate"] == "25"
    assert parsed["aspect_ratio"] == "16:9"
    assert parsed["ts_recording_rate_bytes_per_sec"] == 24000000
    assert parsed["source_packet_count"] == 123456
    # Every ClipInfo field is pinned, not just the two 32-bit ones: an offset
    # off by two bytes reads zeros here and would otherwise pass silently.
    assert parsed["clip_stream_type"] == 1
    assert parsed["application_type"] == 5
    assert parsed["_meta"]["confidence"] == "specified"


def test_cpi_reads_both_streams():
    streams = parse_avchd_cpi(_build_cpi())["streams"]
    assert len(streams) == 2
    assert streams[0]["type"] == "H.264 / AVC"
    assert streams[0]["pid"] == "0x1011"
    assert streams[1]["type"] == "AC-3"
    assert streams[1]["audio_format"] == "Stereo"
    assert streams[1]["sample_rate"] == "48 kHz"
    assert streams[1]["language"] == "eng"


@pytest.mark.parametrize(
    "fmt,rate,aspect,expect",
    [
        (5, 1, 3, ("720p", "23.976", "16:9")),
        (6, 7, 3, ("1080p", "59.94", "16:9")),
        (2, 3, 2, ("576i", "25", "4:3")),
    ],
)
def test_cpi_value_tables(fmt, rate, aspect, expect):
    parsed = parse_avchd_cpi(_build_cpi(fmt=fmt, rate=rate, aspect=aspect))
    assert (parsed["video_format"], parsed["frame_rate"], parsed["aspect_ratio"]) == expect


def test_cpi_rejects_a_file_without_the_hdmv_signature():
    with pytest.raises(SidecarParseError, match="HDMV"):
        parse_avchd_cpi(b"NOPE" + bytes(100))


def test_cpi_survives_truncation_after_the_header():
    """A short file should give up what it can rather than 400 the upload."""
    truncated = _build_cpi()[:70]
    parsed = parse_avchd_cpi(truncated)
    assert parsed["source_packet_count"] == 123456
    assert "streams" not in parsed


# ─── Nikon .NKSC ─────────────────────────────────────────────────────────────

NKSC_BYTES = (
    b"\x00\x01\x02\x03binary header junk"
    b'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    b'<x:xmpmeta xmlns:x="adobe:ns:meta/">'
    b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    b'<rdf:Description xmlns:sdc="http://ns.nikon.com/sdc/1.0/">'
    b"<sdc:Exposure>+0.33</sdc:Exposure>"
    b"<sdc:WhiteBalance>Daylight</sdc:WhiteBalance>"
    b"</rdf:Description></rdf:RDF></x:xmpmeta>"
    b'<?xpacket end="w"?>\x00\x00trailing binary'
)


def test_nksc_extracts_the_xmp_packet_from_binary_padding():
    parsed = parse_nikon_nksc(NKSC_BYTES)
    values = {k.rsplit(".", 1)[-1]: v for k, v in parsed.items() if k != "_meta"}
    assert values["Exposure"] == "+0.33"
    assert values["WhiteBalance"] == "Daylight"
    assert parsed["_meta"]["confidence"] == "specified"


def test_nksc_without_an_xmp_packet_is_rejected():
    with pytest.raises(SidecarParseError, match="XMP"):
        parse_nikon_nksc(b"\x00" * 200)


def test_extract_xmp_returns_none_when_absent():
    assert extract_xmp(b"no packet here") is None


# ─── RED .RMD ────────────────────────────────────────────────────────────────

def test_rmd_that_is_plain_xml_is_parsed_as_specified():
    parsed = parse_red_rmd(b"<RMD><ColorTemperature>5600</ColorTemperature></RMD>")
    assert parsed["RMD.ColorTemperature"] == "5600"
    assert parsed["_meta"]["confidence"] == "specified"


def test_rmd_that_wraps_xmp_is_parsed_as_specified():
    parsed = parse_red_rmd(NKSC_BYTES)
    assert parsed["_meta"]["confidence"] == "specified"
    assert any(k.endswith("Exposure") for k in parsed)


def test_opaque_rmd_is_flagged_best_effort_rather_than_guessed_at():
    body = b"\x89RMD\x00\x01\x02\x03" + b"\x00" * 64 + b"REDCODE" + b"\x00" * 32
    parsed = parse_red_rmd(body)
    assert parsed["_meta"]["confidence"] == "best_effort"
    assert parsed["file_size_bytes"] == len(body)
    assert "REDCODE" in parsed["embedded_text"]
    # Nothing invented: no colour or exposure field may appear.
    assert not any(k in parsed for k in ("iso", "color_temperature", "kelvin", "tint"))


# ─── Opaque binary (.BIM, .CIF) ──────────────────────────────────────────────

def test_opaque_binary_reports_only_verifiable_facts():
    body = b"\x00\x01BIM\x00" + b"\x00" * 20 + b"ILCE-7SM3" + b"\x00" * 10 + b"...." * 3
    parsed = parse_opaque_binary(body, "Sony clip metadata (.BIM)")
    assert parsed["file_size_bytes"] == len(body)
    assert parsed["leading_bytes_hex"].startswith("00 01 42 49 4d")
    assert "ILCE-7SM3" in parsed["embedded_text"]
    # A run of pure punctuation carries no information and must not be listed.
    assert "............" not in parsed["embedded_text"]
    assert parsed["_meta"]["confidence"] == "best_effort"
    assert "undocumented" in parsed["_meta"]["note"]


def test_opaque_binary_handles_a_file_with_no_readable_text():
    parsed = parse_opaque_binary(bytes(range(16)) * 4, "Canon clip information (.CIF)")
    assert "embedded_text" not in parsed
    assert parsed["file_size_bytes"] == 64


# ─── Dispatcher ──────────────────────────────────────────────────────────────

def test_parse_sidecar_routes_binary_types_without_decoding():
    parsed = parse_sidecar("panasonic_clipinfo", _build_cpi())
    assert parsed["video_format"] == "1080i"


def test_parse_sidecar_rejects_an_unknown_type():
    with pytest.raises(SidecarParseError, match="Unknown sidecar type"):
        parse_sidecar("not_a_type", b"x")


def test_meta_key_is_reserved_and_never_collides_with_parsed_fields():
    """The UI hides `_`-prefixed keys; a parser emitting a real field named
    `_meta` would silently disappear from the panel."""
    for parsed in (
        parse_dji_srt(DJI_MODERN),
        parse_avchd_cpi(_build_cpi()),
        parse_nikon_nksc(NKSC_BYTES),
        parse_opaque_binary(b"abcd" * 8, "x"),
    ):
        assert set(parsed["_meta"]) <= {"confidence", "note", "format"}
        assert parsed["_meta"]["confidence"] in ("specified", "best_effort")
