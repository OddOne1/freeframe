"""Parsers for sidecar files. Stdlib only.

Same principle as the exiftool pass: extract everything the format actually
offers, curate only what gets displayed. Empty and placeholder values are
dropped at parse time rather than stored, so no blank rows can render.

Two tiers of confidence, and the distinction is deliberate (§23c, 2026-08-15):

  * **Specified** — ASC CDL, ALE, generic camera XML, DJI .SRT, and AVCHD
    .CPI. Each has either a published spec or a real implementation to ground
    the parser against, so what comes out is trustworthy.
  * **Best-effort** — Sony .BIM, Canon .CIF, and whatever a RED .RMD turns out
    to be when it isn't XML. These formats are proprietary and undocumented.
    Rather than guessing at a byte layout and producing plausible-but-wrong
    numbers, these extract only what can actually be verified from the bytes
    (magic, size, embedded text) and tag the result so the UI can say so.

The `_meta` key carries that provenance. Keys starting with `_` are reserved
for parser bookkeeping and are not rendered as metadata rows.
"""

import logging
import re
import struct
import xml.etree.ElementTree as ET
from typing import Optional

logger = logging.getLogger(__name__)

CDL_EXTENSIONS = {".cdl", ".cc", ".ccc"}
ALE_EXTENSIONS = {".ale"}
# Sony (BPAV/CLPR), Panasonic P2 and Canon all write per-clip XML with their
# own schema, which is exactly what the generic flattener already handles.
XML_EXTENSIONS = {".xml"}
DJI_SRT_EXTENSIONS = {".srt"}
CPI_EXTENSIONS = {".cpi"}
NKSC_EXTENSIONS = {".nksc"}
RMD_EXTENSIONS = {".rmd"}
SONY_BIM_EXTENSIONS = {".bim"}
CANON_CIF_EXTENSIONS = {".cif"}

SIDECAR_EXTENSIONS = (
    CDL_EXTENSIONS
    | ALE_EXTENSIONS
    | XML_EXTENSIONS
    | DJI_SRT_EXTENSIONS
    | CPI_EXTENSIONS
    | NKSC_EXTENSIONS
    | RMD_EXTENSIONS
    | SONY_BIM_EXTENSIONS
    | CANON_CIF_EXTENSIONS
)

# Types whose payload is binary and must never be forced through a UTF-8
# decode — the router branches on this rather than assuming text.
BINARY_SIDECAR_TYPES = {"panasonic_clipinfo", "sony_bim", "canon_cif", "nikon_nksc", "red_rmd"}

_EMPTY_VALUES = {"", "-", "n/a", "none", "null", "undefined"}


class SidecarParseError(Exception):
    """Raised when a file claims a sidecar extension but isn't parseable as
    one. Surfaced to the uploader rather than swallowed — silently storing
    an unparsed sidecar would look like success and show nothing."""


def _clean(value) -> Optional[str]:
    """Normalize a scalar, or None if it carries no real information."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in _EMPTY_VALUES:
        return None
    return text


def _strip_ns(tag: str) -> str:
    """`{urn:ASC:CDL:v1.2}ColorCorrection` -> `ColorCorrection`.

    CDL files in the wild are inconsistent about declaring the ASC
    namespace, so matching on the local name is the only reliable approach.
    """
    return tag.split("}", 1)[-1] if "}" in tag else tag


def detect_sidecar_type(filename: str) -> Optional[str]:
    """Map a filename to a SidecarType value, or None if not a sidecar."""
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ext in CDL_EXTENSIONS:
        return "cdl"
    if ext in ALE_EXTENSIONS:
        return "ale"
    if ext in XML_EXTENSIONS:
        return "camera_xml"
    if ext in DJI_SRT_EXTENSIONS:
        return "dji_srt"
    if ext in CPI_EXTENSIONS:
        return "panasonic_clipinfo"
    if ext in NKSC_EXTENSIONS:
        return "nikon_nksc"
    if ext in RMD_EXTENSIONS:
        return "red_rmd"
    if ext in SONY_BIM_EXTENSIONS:
        return "sony_bim"
    if ext in CANON_CIF_EXTENSIONS:
        return "canon_cif"
    return None


def _mark(payload: dict, confidence: str, note: str, fmt: Optional[str] = None) -> dict:
    """Attach parser provenance under the reserved `_meta` key.

    `confidence` is either "specified" (grounded in a published spec or a real
    implementation) or "best_effort" (proprietary format, only what could be
    verified from the bytes). The UI reads this to label the block rather than
    presenting a guess as fact.
    """
    payload["_meta"] = {"confidence": confidence, "note": note}
    if fmt:
        payload["_meta"]["format"] = fmt
    return payload


# ─── ASC CDL ─────────────────────────────────────────────────────────────────

def parse_cdl(text: str) -> dict:
    """Parse ASC CDL (.cdl / .cc / .ccc).

    A `.ccc` collection can hold several ColorCorrection blocks; `.cdl` and
    `.cc` normally hold one. All of them are returned under
    `color_corrections`, so a collection isn't silently truncated to its
    first entry.

    Slope/offset/power are kept as three-float lists (RGB) rather than
    flattened to strings — the UI renders them as grouped triplets, and
    they're numerically meaningful next to the LUT tooling.
    """
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise SidecarParseError(f"Not valid XML: {exc}") from exc

    corrections = []
    # The root itself may be a ColorCorrection (a bare .cc file).
    candidates = []
    if _strip_ns(root.tag) == "ColorCorrection":
        candidates = [root]
    else:
        candidates = [el for el in root.iter() if _strip_ns(el.tag) == "ColorCorrection"]

    for node in candidates:
        entry: dict = {}
        cc_id = node.get("id") or node.get("ID")
        if _clean(cc_id):
            entry["id"] = _clean(cc_id)

        for child in node.iter():
            name = _strip_ns(child.tag)
            if name in ("Slope", "Offset", "Power"):
                parts = (child.text or "").split()
                try:
                    values = [float(p) for p in parts]
                except ValueError:
                    continue
                if len(values) == 3:
                    entry[name.lower()] = values
            elif name == "Saturation":
                try:
                    entry["saturation"] = float((child.text or "").strip())
                except ValueError:
                    pass
            elif name in ("Description", "InputDescription", "ViewingDescription"):
                cleaned = _clean(child.text)
                if cleaned:
                    # Multiple Description elements are legal; keep them all.
                    key = _snake(name)
                    entry.setdefault(key, [])
                    if isinstance(entry[key], list):
                        entry[key].append(cleaned)

        if entry:
            corrections.append(entry)

    if not corrections:
        raise SidecarParseError("No ColorCorrection blocks found — is this an ASC CDL file?")

    return {"color_corrections": corrections}


# ─── ALE ─────────────────────────────────────────────────────────────────────

def parse_ale(text: str) -> dict:
    """Parse an Avid Log Exchange file — tab-delimited text, not XML.

    Structure: a `Heading` section of key/value lines, a `Column` section
    with one tab-delimited header row, then `Data` rows (one per clip).

    Columns beyond the standard set vary by production and DIT, so whatever
    columns are actually present are stored rather than a fixed schema being
    assumed.
    """
    lines = text.splitlines()
    section = None
    heading: dict = {}
    columns: list[str] = []
    rows: list[dict] = []

    for raw in lines:
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped in ("Heading", "Column", "Data"):
            section = stripped
            continue

        if section == "Heading":
            # Heading lines are `Key<TAB>Value`, occasionally space-separated.
            parts = raw.split("\t") if "\t" in raw else raw.split(None, 1)
            if len(parts) >= 2:
                key, value = _clean(parts[0]), _clean(parts[1])
                if key and value:
                    heading[_snake(key)] = value
        elif section == "Column":
            if not columns:
                columns = [c.strip() for c in raw.split("\t") if c.strip()]
        elif section == "Data":
            values = raw.split("\t")
            if not columns:
                continue
            row: dict = {}
            for i, col in enumerate(columns):
                value = _clean(values[i]) if i < len(values) else None
                if value is not None:
                    row[_snake(col)] = value
            if row:
                rows.append(row)

    if not columns and not heading:
        raise SidecarParseError("No Heading or Column section found — is this an ALE file?")

    result: dict = {}
    if heading:
        result["heading"] = heading
    if columns:
        result["columns"] = columns
    if rows:
        result["clips"] = rows
    return result


def select_ale_row(parsed: dict, clip_name: str) -> Optional[dict]:
    """Find the ALE row matching one clip, by any of the usual name columns.

    An ALE routinely describes a whole shoot day, so attaching all of it to
    one asset would be noise. Returns None when nothing matches — the caller
    then stores the whole file rather than guessing.
    """
    target = _basename_no_ext(clip_name).lower()
    for row in parsed.get("clips") or []:
        for key in ("name", "clip_name", "source_file_name", "tape", "camroll", "labroll"):
            value = row.get(key)
            if value and _basename_no_ext(value).lower() == target:
                return row
    return None


# ─── Camera XML ──────────────────────────────────────────────────────────────

def parse_camera_xml(text: str) -> dict:
    """Generic XML-to-flat-dict flattener.

    v1 scope, per the spec: Sony, Canon and ARRI each use their own schema
    and no manufacturer was specified, so this walks any tree and joins
    nested tag paths with `.` rather than guessing at one vendor's layout.
    The tradeoff is raw field names (`Item.LensInfo.FocalLength`) instead of
    humanized labels — a per-manufacturer parser is a scoped follow-up once
    it's known which system actually matters here.
    """
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise SidecarParseError(f"Not valid XML: {exc}") from exc

    flat: dict = {}

    def walk(node, path: str) -> None:
        name = _strip_ns(node.tag)
        current = f"{path}.{name}" if path else name

        for attr, value in (node.attrib or {}).items():
            cleaned = _clean(value)
            if cleaned is not None:
                flat.setdefault(f"{current}.{_strip_ns(attr)}", cleaned)

        text_value = _clean(node.text)
        if text_value is not None:
            # Repeated paths (list-like elements) get suffixed rather than
            # overwriting each other.
            if current in flat:
                i = 2
                while f"{current}_{i}" in flat:
                    i += 1
                flat[f"{current}_{i}"] = text_value
            else:
                flat[current] = text_value

        for child in list(node):
            walk(child, current)

    walk(root, "")

    if not flat:
        raise SidecarParseError("No readable values found in this XML file")
    return flat


# ─── DJI .SRT flight telemetry ───────────────────────────────────────────────

# A whole clip's telemetry is one sample per frame — 9,000 rows for a five
# minute 30fps flight. Storing all of it in JSONB would bloat the row and
# render as an unusable wall of text, so the track is evenly downsampled to
# this many points. The summary below is computed over *every* sample first,
# so ranges stay exact even though the stored track is thinned.
MAX_TELEMETRY_SAMPLES = 240

_SRT_TIME_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)
_HTML_TAG_RE = re.compile(r"<[^>]*>")
_BRACKET_RE = re.compile(r"\[([^\[\]]*)\]")
# `GPS(12.3,47.6,15)` / `HOME(12.3,47.6)` — a named tuple of numbers.
_PAREN_RE = re.compile(r"\b([A-Za-z][A-Za-z0-9_ ]*)\(([^()]*)\)")
# Key of a `key: value` pair. Must start with a letter, so a clock time
# (`10:00:00`) inside a payload line can never be mistaken for one.
_KEY_TOKEN_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_ ]*?)\s*:\s*")
_DATETIME_RE = re.compile(r"\d{4}[-./]\d{2}[-./]\d{2}[ T]\d{2}:\d{2}:\d{2}")


def _srt_seconds(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000.0


def _kv_pairs(segment: str) -> dict:
    """Pull `key: value` pairs out of one payload segment.

    Values run until the next key starts, which is what makes
    `[rel_alt: 1.200 abs_alt: 512.345]` — two pairs inside one bracket, with a
    space-separated value — come apart correctly. A value also stops at the end
    of its own line: the last pair on a line would otherwise swallow every
    following line up to the next key, which is exactly what happens to
    `DiffTime: 33ms` when a bare timestamp line follows it.
    """
    out: dict = {}
    matches = list(_KEY_TOKEN_RE.finditer(segment))
    for i, match in enumerate(matches):
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(segment)
        key = _snake(match.group(1))
        value = _clean(segment[start:end].split("\n", 1)[0].strip().rstrip(",;"))
        if key and value:
            out.setdefault(key, value)
    return out


def _parse_srt_payload(lines: list[str]) -> dict:
    """Extract every field a DJI telemetry payload carries, whatever its dialect.

    DJI has shipped several: bracketed `[iso: 100]` pairs on newer drones,
    `GPS(lon,lat,n)` tuples on older ones, and a bare timestamp line on both.
    All three shapes are handled rather than one being assumed, because the
    dialect varies by aircraft and firmware, not by anything visible here.
    """
    text = _HTML_TAG_RE.sub(" ", "\n".join(lines))
    fields: dict = {}

    stamp = _DATETIME_RE.search(text)
    if stamp:
        fields["timestamp"] = stamp.group(0)

    # Named tuples first, and blanked out afterwards so their contents can't be
    # re-read as key/value pairs.
    def take_paren(match: re.Match) -> str:
        key = _snake(match.group(1))
        parts = [p.strip() for p in match.group(2).split(",") if p.strip()]
        if key and parts:
            fields.setdefault(key, parts if len(parts) > 1 else parts[0])
        return " "

    text = _PAREN_RE.sub(take_paren, text)

    for bracket in _BRACKET_RE.findall(text):
        fields.update({k: v for k, v in _kv_pairs(bracket).items() if k not in fields})
    text = _BRACKET_RE.sub(" ", text)

    for key, value in _kv_pairs(text).items():
        fields.setdefault(key, value)

    return fields


def _as_float(value) -> Optional[float]:
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    match = re.match(r"^[+-]?\d+(?:\.\d+)?", value.strip())
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def parse_dji_srt(text: str) -> dict:
    """Parse a DJI .SRT — flight telemetry that reuses SubRip syntax.

    Not a caption track (§23b): the blocks carry GPS, altitude, gimbal angles
    and exposure per frame. Real subtitle files land here too if someone
    uploads one, and they parse to blocks with no telemetry fields at all —
    which is reported as such rather than stored as an empty track.
    """
    blocks: list[dict] = []
    for raw_block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n")):
        block = raw_block.strip()
        if not block:
            continue
        lines = block.split("\n")
        timing = None
        payload_start = 0
        for i, line in enumerate(lines[:3]):
            match = _SRT_TIME_RE.search(line)
            if match:
                timing = match
                payload_start = i + 1
                break
        if timing is None:
            continue
        fields = _parse_srt_payload(lines[payload_start:])
        if not fields:
            continue
        blocks.append({
            "t": round(_srt_seconds(*timing.group(1, 2, 3, 4)), 3),
            "t_end": round(_srt_seconds(*timing.group(5, 6, 7, 8)), 3),
            **fields,
        })

    if not blocks:
        raise SidecarParseError(
            "No timestamped telemetry blocks found — is this a DJI flight-log .SRT? "
            "Plain subtitle files carry no telemetry and aren't stored as sidecars."
        )

    # Ranges are computed across every sample, before downsampling, so the
    # summary describes the real flight rather than the stored excerpt.
    numeric: dict = {}
    field_names: list[str] = []
    for block in blocks:
        for key, value in block.items():
            if key not in field_names and key not in ("t", "t_end"):
                field_names.append(key)
            number = _as_float(value)
            if number is None:
                continue
            entry = numeric.setdefault(key, {"min": number, "max": number})
            entry["min"] = min(entry["min"], number)
            entry["max"] = max(entry["max"], number)

    summary: dict = {}
    for key in ("latitude", "longitude", "rel_alt", "abs_alt", "altitude", "gb_pitch", "gb_yaw", "gb_roll"):
        if key in numeric:
            summary[key] = {"min": numeric[key]["min"], "max": numeric[key]["max"]}

    step = max(1, len(blocks) // MAX_TELEMETRY_SAMPLES)
    sampled = blocks[::step][:MAX_TELEMETRY_SAMPLES]

    result: dict = {
        "sample_count": len(blocks),
        "duration_seconds": round(blocks[-1]["t_end"], 3),
        "fields": field_names,
        "samples": sampled,
    }
    if len(sampled) < len(blocks):
        result["samples_downsampled"] = f"showing {len(sampled)} of {len(blocks)}"
    if summary:
        result["ranges"] = summary
    if blocks[0].get("timestamp"):
        result["first_timestamp"] = blocks[0]["timestamp"]

    return _mark(
        result,
        "specified",
        "SubRip block structure is standard; DJI's own field names are passed through as written.",
        fmt="DJI flight telemetry (.SRT)",
    )


# ─── AVCHD / Blu-ray clip information (.CPI) ─────────────────────────────────

# Value tables and the byte layout below are transcribed from libbluray's
# reference implementation (src/libbluray/bdnav/clpi_parse.c and bluray.h,
# LGPL) rather than reconstructed from prose — the AVCHD spec itself is
# proprietary to Sony/Panasonic and not public. Only the fields that
# implementation actually decodes are read here; nothing is inferred past that
# point, which is why there's no duration or bitrate in the output.
_CPI_STREAM_TYPES = {
    0x01: "MPEG-1 Video", 0x02: "MPEG-2 Video", 0x1B: "H.264 / AVC", 0xEA: "VC-1",
    0x20: "H.264 MVC", 0x03: "MPEG-1 Audio", 0x04: "MPEG-2 Audio", 0x80: "LPCM",
    0x81: "AC-3", 0x82: "DTS", 0x83: "Dolby TrueHD", 0x84: "AC-3 Plus",
    0x85: "DTS-HD", 0x86: "DTS-HD Master", 0xA1: "AC-3 Plus (secondary)",
    0xA2: "DTS-HD (secondary)", 0x90: "Presentation Graphics", 0x91: "Interactive Graphics",
    0x92: "Text subtitle", 0xA0: "Secondary",
}
_CPI_VIDEO_FORMATS = {1: "480i", 2: "576i", 3: "480p", 4: "1080i", 5: "720p", 6: "1080p", 7: "576p"}
_CPI_FRAME_RATES = {1: "23.976", 2: "24", 3: "25", 4: "29.97", 6: "50", 7: "59.94"}
_CPI_ASPECTS = {2: "4:3", 3: "16:9"}
_CPI_AUDIO_FORMATS = {1: "Mono", 3: "Stereo", 6: "Multi-channel", 12: "Stereo + multi-channel"}
_CPI_AUDIO_RATES = {1: "48 kHz", 4: "96 kHz", 5: "192 kHz", 12: "48/192 kHz", 14: "48/96 kHz"}

_CPI_VIDEO_CODINGS = {0x01, 0x02, 0xEA, 0x1B, 0x20}
_CPI_AUDIO_CODINGS = {0x03, 0x04, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0xA1, 0xA2}
_CPI_LANG_ONLY_CODINGS = {0x90, 0x91, 0xA0}


def _u32(data: bytes, off: int) -> int:
    return struct.unpack_from(">I", data, off)[0]


def parse_avchd_cpi(data: bytes) -> dict:
    """Parse an AVCHD/Blu-ray Clip Information file (.CPI).

    Layout per libbluray: 'HDMV' + a 4-digit version, five 32-bit section
    offsets, a ClipInfo block at byte 40, and a ProgramInfo block whose
    per-stream attributes carry the codec, video format, frame rate and aspect
    ratio — the fields that make this worth parsing at all.
    """
    if len(data) < 28 or data[0:4] != b"HDMV":
        raise SidecarParseError(
            "Not an AVCHD clip-information file — expected an 'HDMV' signature at byte 0."
        )

    version = data[4:8].decode("ascii", "replace")
    program_info_addr = _u32(data, 12)

    result: dict = {"version": version}

    # ── ClipInfo, fixed at byte 40 ──
    #   40-43 length · 44-45 reserved · 46 clip_stream_type · 47 application_type
    #   48-51 reserved(31b)+is_atc_delta(1b) · 52-55 ts_recording_rate
    #   56-59 num_source_packets
    try:
        result["clip_stream_type"] = data[46]
        result["application_type"] = data[47]
        result["ts_recording_rate_bytes_per_sec"] = _u32(data, 52)
        result["source_packet_count"] = _u32(data, 56)
    except (IndexError, struct.error):
        # A truncated ClipInfo isn't fatal — ProgramInfo may still be readable.
        logger.debug("CPI ClipInfo block truncated")

    # ── ProgramInfo ──
    streams: list[dict] = []
    try:
        pos = program_info_addr + 5
        program_count = data[pos]
        pos += 1
        for _ in range(program_count):
            pos += 6  # spn_program_sequence_start (4) + program_map_pid (2)
            stream_count = data[pos]
            pos += 2  # num_streams + num_groups
            for _ in range(stream_count):
                pid = struct.unpack_from(">H", data, pos)[0]
                pos += 2
                attr_len = data[pos]
                pos += 1
                attr_end = pos + attr_len
                coding = data[pos]
                entry: dict = {"pid": f"0x{pid:04x}"}
                entry["type"] = _CPI_STREAM_TYPES.get(coding, f"unknown (0x{coding:02x})")
                if coding in _CPI_VIDEO_CODINGS:
                    fmt_rate = data[pos + 1]
                    aspect = data[pos + 2]
                    entry["video_format"] = _CPI_VIDEO_FORMATS.get(fmt_rate >> 4)
                    entry["frame_rate"] = _CPI_FRAME_RATES.get(fmt_rate & 0x0F)
                    entry["aspect_ratio"] = _CPI_ASPECTS.get(aspect >> 4)
                elif coding in _CPI_AUDIO_CODINGS:
                    fmt_rate = data[pos + 1]
                    entry["audio_format"] = _CPI_AUDIO_FORMATS.get(fmt_rate >> 4)
                    entry["sample_rate"] = _CPI_AUDIO_RATES.get(fmt_rate & 0x0F)
                    entry["language"] = _clean(data[pos + 2:pos + 5].decode("ascii", "replace"))
                elif coding in _CPI_LANG_ONLY_CODINGS:
                    entry["language"] = _clean(data[pos + 1:pos + 4].decode("ascii", "replace"))
                streams.append({k: v for k, v in entry.items() if v is not None})
                pos = attr_end
    except (IndexError, struct.error):
        logger.debug("CPI ProgramInfo block truncated after %d stream(s)", len(streams))

    if streams:
        result["streams"] = streams
        # Lift the first video stream's attributes to the top level: they're
        # what someone opens this panel to see.
        for stream in streams:
            if "video_format" in stream:
                for key in ("video_format", "frame_rate", "aspect_ratio"):
                    if stream.get(key):
                        result[key] = stream[key]
                break

    if len(result) <= 1:
        raise SidecarParseError("Clip-information file carried no readable stream attributes")

    return _mark(
        result,
        "specified",
        "Decoded using libbluray's CLPI reference implementation; the AVCHD spec itself is not public.",
        fmt="AVCHD clip information (.CPI)",
    )


# ─── XMP-bearing sidecars (.NKSC, and .RMD when it happens to be XMP) ────────

_XMP_START = re.compile(rb"<x:xmpmeta[^>]*>")
_XMP_END = b"</x:xmpmeta>"


def extract_xmp(data: bytes) -> Optional[str]:
    """Pull an XMP packet out of a file that wraps one in binary padding.

    Nikon's .NKSC is exactly this shape: an XMP document (with Nikon's own
    namespaces alongside the standard ones) sitting inside a container this
    parser has no reason to understand.
    """
    start = _XMP_START.search(data)
    if not start:
        return None
    end = data.find(_XMP_END, start.end())
    if end == -1:
        return None
    packet = data[start.start():end + len(_XMP_END)]
    return packet.decode("utf-8", "replace")


def parse_nikon_nksc(data: bytes) -> dict:
    """Parse a Nikon NX Studio sidecar (.NKSC) — an XMP packet in a binary wrapper."""
    xmp = extract_xmp(data)
    if xmp is None:
        raise SidecarParseError(
            "No XMP packet found — this doesn't look like a Nikon NX Studio sidecar."
        )
    parsed = parse_camera_xml(xmp)
    return _mark(
        parsed,
        "specified",
        "Nikon's adjustment values live in its own XMP namespaces and are shown under their raw tag paths.",
        fmt="Nikon sidecar (.NKSC)",
    )


def parse_red_rmd(data: bytes) -> dict:
    """Parse a RED .RMD, or report honestly that it couldn't be.

    RED's format is not documented and reports of its contents conflict — some
    .RMD files are readable XML/XMP, others are opaque. Rather than guessing at
    a binary layout (which would produce plausible, wrong colour values), this
    tries the two shapes that can be verified and otherwise falls through to
    the best-effort path, which says so.
    """
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = None

    if text and text.lstrip().startswith("<"):
        try:
            return _mark(
                parse_camera_xml(text),
                "specified",
                "This .RMD was readable XML and is shown as written; RED's schema itself is undocumented.",
                fmt="RED metadata sidecar (.RMD)",
            )
        except SidecarParseError:
            pass

    xmp = extract_xmp(data)
    if xmp is not None:
        try:
            return _mark(
                parse_camera_xml(xmp),
                "specified",
                "Read from the XMP packet embedded in this .RMD; RED's own fields outside it are not decoded.",
                fmt="RED metadata sidecar (.RMD)",
            )
        except SidecarParseError:
            pass

    return _mark(
        _describe_opaque(data),
        "best_effort",
        "RED's .RMD layout is undocumented and this file is not XML or XMP. "
        "The file is stored intact; only what could be read from the bytes is shown.",
        fmt="RED metadata sidecar (.RMD)",
    )


# ─── Undocumented binary sidecars (.BIM, .CIF) ───────────────────────────────

_MIN_STRING_LEN = 4
_MAX_STRINGS = 40
_PRINTABLE = re.compile(rb"[\x20-\x7e]{%d,}" % _MIN_STRING_LEN)
# Reject runs that are just punctuation or padding — a row of dots says nothing.
_MEANINGFUL = re.compile(r"[A-Za-z0-9]{3,}")


def _describe_opaque(data: bytes) -> dict:
    """What can be stated about a binary file without knowing its format.

    Deliberately limited to facts: how big it is, what its first bytes are, and
    any embedded text. No field is invented, because a wrong ISO or timecode
    read out of a guessed offset looks exactly as convincing as a right one.
    """
    head = data[:8]
    magic_ascii = "".join(chr(b) if 0x20 <= b <= 0x7E else "." for b in head)

    seen: list[str] = []
    for match in _PRINTABLE.findall(data):
        value = match.decode("ascii", "replace").strip()
        if not _MEANINGFUL.search(value):
            continue
        if value not in seen:
            seen.append(value)
        if len(seen) >= _MAX_STRINGS:
            break

    result: dict = {
        "file_size_bytes": len(data),
        "leading_bytes_hex": head.hex(" "),
        "leading_bytes_ascii": magic_ascii,
    }
    if seen:
        result["embedded_text"] = seen
    return result


def parse_opaque_binary(data: bytes, label: str) -> dict:
    return _mark(
        _describe_opaque(data),
        "best_effort",
        f"{label} is a proprietary, undocumented format. The file is stored intact, "
        "but no field layout is known, so only verifiable facts about the bytes are shown.",
        fmt=label,
    )


# ─── Shared ──────────────────────────────────────────────────────────────────

def _decode_text(body: bytes) -> str:
    try:
        return body.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SidecarParseError("Sidecar file must be UTF-8 text") from exc


def parse_sidecar(sidecar_type: str, body: bytes, clip_name: Optional[str] = None) -> dict:
    """Dispatch to the right parser. Raises SidecarParseError on bad input.

    Takes raw bytes rather than decoded text: several of these formats are
    binary, and forcing them through a UTF-8 decode first would reject them
    before their parser ever ran.
    """
    if sidecar_type == "cdl":
        return parse_cdl(_decode_text(body))
    if sidecar_type == "ale":
        parsed = parse_ale(_decode_text(body))
        if clip_name:
            match = select_ale_row(parsed, clip_name)
            if match:
                # Keep the heading for context, but narrow the clip list to
                # the one row that actually describes this asset.
                parsed = {**parsed, "clips": [match], "matched_clip": True}
        return parsed
    if sidecar_type == "camera_xml":
        return parse_camera_xml(_decode_text(body))
    if sidecar_type == "dji_srt":
        return parse_dji_srt(_decode_text(body))
    if sidecar_type == "panasonic_clipinfo":
        return parse_avchd_cpi(body)
    if sidecar_type == "nikon_nksc":
        return parse_nikon_nksc(body)
    if sidecar_type == "red_rmd":
        return parse_red_rmd(body)
    if sidecar_type == "sony_bim":
        return parse_opaque_binary(body, "Sony clip metadata (.BIM)")
    if sidecar_type == "canon_cif":
        return parse_opaque_binary(body, "Canon clip information (.CIF)")
    raise SidecarParseError(f"Unknown sidecar type: {sidecar_type}")


def _snake(name: str) -> str:
    out = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name.strip())
    return re.sub(r"[^a-zA-Z0-9]+", "_", out).strip("_").lower()


def _basename_no_ext(filename: str) -> str:
    base = filename.replace("\\", "/").rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[0] if "." in base else base
