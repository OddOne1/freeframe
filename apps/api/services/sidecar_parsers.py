"""Parsers for ASC CDL, ALE, and camera XML sidecars. Stdlib only.

Same principle as the exiftool pass: extract everything the format actually
offers, curate only what gets displayed. Empty and placeholder values are
dropped at parse time rather than stored, so no blank rows can render.
"""

import logging
import re
import xml.etree.ElementTree as ET
from typing import Optional

logger = logging.getLogger(__name__)

CDL_EXTENSIONS = {".cdl", ".cc", ".ccc"}
ALE_EXTENSIONS = {".ale"}
XML_EXTENSIONS = {".xml"}
SIDECAR_EXTENSIONS = CDL_EXTENSIONS | ALE_EXTENSIONS | XML_EXTENSIONS

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
    return None


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


# ─── Shared ──────────────────────────────────────────────────────────────────

def parse_sidecar(sidecar_type: str, text: str, clip_name: Optional[str] = None) -> dict:
    """Dispatch to the right parser. Raises SidecarParseError on bad input."""
    if sidecar_type == "cdl":
        return parse_cdl(text)
    if sidecar_type == "ale":
        parsed = parse_ale(text)
        if clip_name:
            match = select_ale_row(parsed, clip_name)
            if match:
                # Keep the heading for context, but narrow the clip list to
                # the one row that actually describes this asset.
                parsed = {**parsed, "clips": [match], "matched_clip": True}
        return parsed
    if sidecar_type == "camera_xml":
        return parse_camera_xml(text)
    raise SidecarParseError(f"Unknown sidecar type: {sidecar_type}")


def _snake(name: str) -> str:
    out = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name.strip())
    return re.sub(r"[^a-zA-Z0-9]+", "_", out).strip("_").lower()


def _basename_no_ext(filename: str) -> str:
    base = filename.replace("\\", "/").rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[0] if "." in base else base
