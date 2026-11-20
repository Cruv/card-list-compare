"""Generate approved Silhouette sheets and CLC's metric manual-punch sheets."""
import hashlib
import io
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import warnings

from PIL import Image, ImageDraw, ImageFont, ImageOps
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, EncodedStreamObject, NameObject, NumberObject

CROWNED_LANDSCAPE = "crowned-a4-landscape"
CROWNED_PORTRAIT = "crowned-a4"
CROWNED_PORTRAIT_SIX = "crowned-a4-portrait-six"
DAHLE_A4_PUNCH = "dahle-a4-punch"
PORTRAIT_PRESETS = {CROWNED_PORTRAIT, CROWNED_PORTRAIT_SIX}
CROWNED_LANDSCAPE_GEOMETRY = json.loads(Path(__file__).with_name("crownedLandscapeGeometry.json").read_text())
CROWNED_PORTRAIT_GEOMETRY = json.loads(Path(__file__).with_name("crownedPortraitGeometry.json").read_text())
DAHLE_GEOMETRY = json.loads(Path(__file__).with_name("dahleA4PunchGeometry.json").read_text())
PORTRAIT_CARD = CROWNED_PORTRAIT_GEOMETRY["cardPixels"]
PORTRAIT_MARKS = CROWNED_PORTRAIT_GEOMETRY["registrationMillimeters"]

# The largest approved sheet is A4 at 7014 × 4960 pixels. Source cards keep their smaller cap.
APPROVED_PAPER = {
    "letter": {
        "name": "Letter", "version": 6, "width": "11in", "height": "8.5in",
        "registration_length": "8.04mm", "layout_pixels": (3300, 2550), "raster_pixels": (6600, 5100),
        "x": [140, 899, 1658, 2417], "y": [228, 1282],
    },
    "a4": {
        "name": "A4", "version": 5, "width": "297mm", "height": "210mm",
        # The rounded layout and the truncated Matplotlib registration raster differ.
        "registration_length": "9.4mm", "layout_pixels": (3508, 2480), "raster_pixels": (7014, 4960),
        "x": CROWNED_LANDSCAPE_GEOMETRY["cardPixels"]["x"], "y": CROWNED_LANDSCAPE_GEOMETRY["cardPixels"]["y"],
    },
    CROWNED_PORTRAIT: {
        "name": "Crowned A4", "version": 2, "width": "297mm", "height": "210mm",
        "registration_inset": f"{PORTRAIT_MARKS['inset']}mm", "registration_length": f"{PORTRAIT_MARKS['length']}mm",
        "layout_pixels": (2480, 3508), "raster_pixels": (7014, 4960),
        "x": PORTRAIT_CARD["x"], "y": PORTRAIT_CARD["y"],
    },
}
APPROVED_PAPER[CROWNED_LANDSCAPE] = {**APPROVED_PAPER["a4"], "name": "Crowned A4 Landscape"}
APPROVED_PAPER[CROWNED_PORTRAIT_SIX] = {**APPROVED_PAPER[CROWNED_PORTRAIT], "name": "Crowned A4 Portrait 3×2", "version": 1}
SKIPPED_SLOTS = {
    "letter": (4,), "a4": (4,),
    CROWNED_PORTRAIT_SIX: tuple(range(len(PORTRAIT_CARD["x"]) * CROWNED_PORTRAIT_GEOMETRY["sixCardRows"],
                                     len(PORTRAIT_CARD["x"]) * len(PORTRAIT_CARD["y"]))),
}
Image.MAX_IMAGE_PIXELS = max(width * height for width, height in (paper["raster_pixels"] for paper in APPROVED_PAPER.values()))
MAX_SOURCE_PIXELS = 16_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
MAX_IMAGE_BYTES = 20 * 1024 * 1024
POINTS_PER_MM = 72 / 25.4
MPC_SOURCE_BLEED_MM = 25.4 / 8


def paper_key(request):
    size = request.get("paperSize", "letter")
    preset = request.get("printPreset")
    if preset is None and size in ("letter", "a4"):
        return size
    if preset in (CROWNED_PORTRAIT, CROWNED_PORTRAIT_SIX, CROWNED_LANDSCAPE, DAHLE_A4_PUNCH) and size == "a4":
        return preset
    raise ValueError("Unsupported paper size and print preset")


def approved_geometry(source, recipe):
    if recipe == CROWNED_LANDSCAPE:
        # Crowned Landscape uses the upstream A4 v5 grid and registration marks.
        recipe = "a4"
    elif recipe == CROWNED_PORTRAIT_SIX:
        # The six-card recipe preserves the approved three-row grid, marks and feed orientation.
        recipe = CROWNED_PORTRAIT
    paper = APPROVED_PAPER[recipe]
    portrait = recipe in PORTRAIT_PRESETS
    paper_size = "a4" if portrait else recipe
    variant = "borderless" if portrait else "default"
    inset = paper.get("registration_inset", "10mm")
    sys.path.insert(0, str(source))
    import page_manager
    from enums import Orientation
    config = json.loads((source / "assets/layouts.json").read_text())
    orientation = Orientation.PORTRAIT if portrait else Orientation.LANDSCAPE
    layout = config["layouts"][paper_size]["standard"][variant]
    required = {"orientation": orientation.value, "version": paper["version"],
                "num_rows": len(paper["y"]), "num_cols": len(paper["x"]),
                "registration": {"length": paper["registration_length"]}}
    if layout != required or config["ppi"] != 300:
        raise ValueError(f"Upstream changed the approved {paper['name']} layout")
    if config["card_sizes"]["standard"]["width"] != "63mm" or config["card_sizes"]["standard"]["height"] != "88mm":
        raise ValueError("Upstream changed the approved card dimensions")
    if config["defaults"]["registration"][variant] != {"inset": inset, "thickness": "1mm", "length": "5mm"}:
        raise ValueError("Upstream changed the approved registration settings")
    dimensions = config["paper_sizes"][paper_size]
    if dimensions["width"] != paper["width"] or dimensions["height"] != paper["height"]:
        raise ValueError(f"Upstream changed {paper['name']} dimensions")
    geometry = page_manager.generate_layout(orientation=orientation, card_width="63mm", card_height="88mm",
        paper_width=paper["width"], paper_height=paper["height"], inset=inset, length="6.5mm", ppi=300)
    actual = [geometry.card_width_px, geometry.card_height_px, geometry.paper_width_px, geometry.paper_height_px,
              geometry.x_pos, geometry.y_pos]
    if actual != [744, 1039, *paper["layout_pixels"], paper["x"], paper["y"]]:
        raise ValueError(f"Upstream geometry is incompatible with the approved {paper['name']} cutting template")


def verified_image(source):
    source = Path(source)
    if not source.is_file() or source.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("Missing image or image larger than 20 MiB")
    data = source.read_bytes()
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("Image larger than 20 MiB")
    with Image.open(io.BytesIO(data)) as image:
        if image.format not in ("JPEG", "PNG") or image.width * image.height > MAX_SOURCE_PIXELS:
            raise ValueError("Print faces must be bounded JPEG or PNG images")
        image.verify()
    return data


def image_metadata(image, data):
    return {"sha256": hashlib.sha256(data).hexdigest(), "width": image.width, "height": image.height,
            "mode": image.mode, "hasIccProfile": bool(image.info.get("icc_profile"))}


def image_copy(source, destination):
    data = verified_image(source)
    with Image.open(io.BytesIO(data)) as image:
        image.load()  # Detect incomplete JPEG pixel data before calling upstream.
        metadata = image_metadata(image, data)
        extension = ".jpg" if image.format == "JPEG" else ".png"
    destination.with_suffix(extension).write_bytes(data)
    return metadata


def validate_pdf(filename, count, recipe, *, upstream=False):
    dahle = recipe == DAHLE_A4_PUNCH
    if dahle:
        media_box = [0, 0, *(value * POINTS_PER_MM for value in DAHLE_GEOMETRY["page"])]
        description = "portrait A4 punch"
    else:
        paper = APPROVED_PAPER[recipe]
        width, height = paper["raster_pixels"]
        portrait = recipe in PORTRAIT_PRESETS and not upstream
        page_width, page_height = (height, width) if portrait else (width, height)
        description = f"{'portrait' if portrait else 'landscape'} {paper['name']}"
        media_box = [0, 0, page_width * 72 / 600, page_height * 72 / 600]
    # Passing a filename makes pypdf read the entire file into BytesIO. A file stream
    # plus per-page cache eviction keeps validation proportional to one sheet.
    with open(filename, "rb") as stream:
        reader = PdfReader(stream, strict=True)
        if len(reader.pages) != count:
            raise ValueError(f"Expected {count} pages, got {len(reader.pages)}")
        for page in reader.pages:
            actual_box = list(map(float, page.mediabox))
            if page.rotation or any(abs(actual - expected) > 1e-5 for actual, expected in zip(actual_box, media_box)):
                raise ValueError(f"Generated PDF does not have unrotated {description} pages")
            objects = page["/Resources"]["/XObject"].get_object()
            images = [item.get_object() for item in objects.values() if item.get_object().get("/Subtype") == "/Image"]
            if dahle:
                if not 1 <= len(images) <= len(usable_slots(recipe)):
                    raise ValueError("Generated punch sheet does not contain the expected card images")
            elif len(images) != 1 or images[0]["/Width"] != width or images[0]["/Height"] != height:
                raise ValueError("Generated PDF does not contain the expected 600 PPI page image")
            if any(image["/ColorSpace"] != "/DeviceRGB" for image in images):
                raise ValueError("Generated PDF must contain DeviceRGB images")
            reader.resolved_objects.clear()
        reader.close()


def identify_pages(filename, identification, labels, recipe="letter", *, refeed_front=False, proof_scale=False):
    """Add vector identification between the registration marks and above the artwork."""
    values = [identification.get("requesterName"), identification.get("batchName")]
    if identification.get("version") != 1 or any(not isinstance(value, str) or not value
            or any(ord(char) < 32 or ord(char) > 126 for char in value) for value in values):
        raise ValueError("Page identification must use bounded printable text")
    if len(values[0]) > 48 or len(values[1]) > 96:
        raise ValueError("Page identification exceeds the approved margin")
    temporary = filename.with_suffix(".identified.pdf")
    with open(filename, "rb") as source:
        reader = PdfReader(source, strict=True)
        if len(labels) != len(reader.pages):
            raise ValueError("Every generated page requires its exact identification")
        writer = PdfWriter()
        writer.append(reader, import_outline=False)
        font = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Courier")}))
        for index, page in enumerate(writer.pages):
            item = labels[index]
            label = item.get("label")
            if item.get("page") != index + 1 or item.get("phase") not in ("fronts", "backs") \
                    or not isinstance(label, str) or not 1 <= len(label) <= 96 \
                    or any(ord(char) < 32 or ord(char) > 126 for char in label):
                raise ValueError("Page label must identify its exact sheet and side")
            packet = f"{label} | {'FRONT' if item['phase'] == 'fronts' else 'BACK'}"
            if refeed_front and item["phase"] == "fronts":
                packet += " | REFEED FOR BACK"
            requester_label = "Prepared by" if recipe == DAHLE_A4_PUNCH else "Queued by"
            requester = values[0] if proof_scale else f"{requester_label}: {values[0]}"
            batch = f"{'Recipe' if proof_scale else 'Batch'}: {values[1]}"
            resources = DictionaryObject(page["/Resources"])
            fonts = DictionaryObject(resources.get("/Font", DictionaryObject()).get_object())
            if "/CLCPageIdentity" in fonts:
                raise ValueError("Generated PDF already contains CLC page identification")
            fonts[NameObject("/CLCPageIdentity")] = font
            resources[NameObject("/Font")] = fonts
            page[NameObject("/Resources")] = resources
            portrait = recipe in PORTRAIT_PRESETS
            if portrait:
                # Upstream rotates portrait raster artwork counterclockwise into
                # landscape. Restore portrait on the PDF page without resampling.
                page.rotate(90)
                page.transfer_rotation_to_content()
            top = float(page.mediabox.top)
            # Portrait has more room above the first row. The landscape marks
            # start farther down, leaving space for two lines below their top edge.
            if recipe == DAHLE_A4_PUNCH:
                rows = ((15, requester), (24, batch), (33, packet))
            elif portrait:
                rows = ((18, requester), (27, batch), (36, packet))
            else:
                rows = ((34, f"{requester}  |  {batch}"), (41, packet))
            inset = 66
            # Courier's advance is 0.6 em. Allow room for the final glyph and for
            # rounding without shortening the packet or the manual refeed message.
            room = float(page.mediabox.width) - 2 * inset - 1
            commands = ["q", "0 g", "BT"]
            for offset, text in rows:
                size = min(8 if portrait or recipe == DAHLE_A4_PUNCH else 7, room / (0.6 * len(text)))
                commands.extend((f"/CLCPageIdentity {size:.3f} Tf", f"1 0 0 1 {inset} {top - offset:g} Tm",
                                 f"<{text.encode('ascii').hex()}> Tj"))
            commands.extend(("ET", "Q"))
            if proof_scale:
                scale_width = 50 * POINTS_PER_MM
                left = (float(page.mediabox.width) - scale_width) / 2
                right = left + scale_width
                y = 6 * POINTS_PER_MM
                label_at = (left + right) / 2 - 11
                commands.extend(("q 0 G 0.5 w", f"{left:.6f} {y:g} m {right:.6f} {y:g} l S",
                                 f"{left:.6f} {y-2:g} m {left:.6f} {y+2:g} l S",
                                 f"{right:.6f} {y-2:g} m {right:.6f} {y+2:g} l S",
                                 f"BT /CLCPageIdentity 7 Tf 1 0 0 1 {label_at:g} {y+4:g} Tm (50 mm) Tj ET Q"))
            overlay = DecodedStreamObject()
            overlay.set_data(("\n" + "\n".join(commands) + "\n").encode("ascii"))
            contents = page.raw_get("/Contents")
            contents = list(contents.get_object()) if isinstance(contents.get_object(), ArrayObject) else [contents]
            page[NameObject("/Contents")] = ArrayObject([*contents, writer._add_object(overlay)])
        with open(temporary, "wb") as destination:
            writer.write(destination)
        reader.close()
    temporary.replace(filename)


def usable_slots(recipe):
    if recipe == DAHLE_A4_PUNCH:
        return list(range(DAHLE_GEOMETRY["columns"] * DAHLE_GEOMETRY["rows"]))
    paper = APPROVED_PAPER[recipe]
    return [slot for slot in range(len(paper["x"]) * len(paper["y"])) if slot not in SKIPPED_SLOTS.get(recipe, ())]


def dahle_source_bleed(size, source):
    width, height = size
    trim_width, trim_height = DAHLE_GEOMETRY["trim"]

    def matches(bleed):
        expected = (trim_width + 2 * bleed) / (trim_height + 2 * bleed)
        return abs(width / height / expected - 1) <= 0.005

    # MPC contributor files do not expose a trim box. Accept only the recognizable
    # 63 × 88 mm template with 1/8 in bleed or full-card artwork with a trim aspect.
    if source == "saved-mpc" and matches(MPC_SOURCE_BLEED_MM):
        return MPC_SOURCE_BLEED_MM
    if source in (None, "scryfall", "saved-mpc") and matches(0):
        return 0
    raise ValueError("Dahle punch artwork has no recognized 63 × 88 mm trim geometry. "
                     "Choose Scryfall or MPC artwork made for the 63 × 88 mm template.")


def opaque_artwork(image):
    if "A" not in image.getbands() and "transparency" not in image.info:
        return image.convert("RGB")
    rgba = image.convert("RGBA")
    rgb = Image.new("RGB", image.size, "white")
    alpha = rgba.getchannel("A")
    rgb.paste(rgba, mask=alpha)
    # Scryfall's PNG corners are transparent. Fill the corner pixels from the
    # artwork edge before extending it so rounded scans do not bleed white.
    opaque = alpha.point(lambda value: 255 if value >= 240 else 0)
    bounds = opaque.getbbox()
    if bounds is None:
        raise ValueError("Dahle punch artwork has no opaque card area")
    for y in range(image.height):
        sample_y = min(max(y, bounds[1]), bounds[3] - 1)
        row = opaque.crop((0, sample_y, image.width, sample_y + 1)).getbbox()
        if row is None:
            continue
        if sample_y != y:
            rgb.paste(rgb.crop((0, sample_y, image.width, sample_y + 1)), (0, y))
        left, _, right, _ = row
        if left:
            rgb.paste(rgb.getpixel((left, y)), (0, y, left, y + 1))
        if right < image.width:
            rgb.paste(rgb.getpixel((right - 1, y)), (right, y, image.width, y + 1))
    return rgb


def mirror_artwork_edges(image, pad):
    width, height = image.size
    horizontal = Image.new("RGB", (width + 2 * pad, height))
    horizontal.paste(ImageOps.mirror(image.crop((0, 0, pad, height))), (0, 0))
    horizontal.paste(image, (pad, 0))
    horizontal.paste(ImageOps.mirror(image.crop((width - pad, 0, width, height))), (width + pad, 0))
    padded = Image.new("RGB", (horizontal.width, height + 2 * pad))
    padded.paste(ImageOps.flip(horizontal.crop((0, 0, horizontal.width, pad))), (0, 0))
    padded.paste(horizontal, (0, pad))
    padded.paste(ImageOps.flip(horizontal.crop((0, height - pad, horizontal.width, height))), (0, height + pad))
    return padded


def dahle_face(path, source, output_bleed):
    data = verified_image(path)
    with Image.open(io.BytesIO(data)) as image:
        metadata = image_metadata(image, data)
        source_bleed = dahle_source_bleed(image.size, source)
        artwork = opaque_artwork(image)
    metadata["sourceBleedMm"] = source_bleed
    trim_width, trim_height = DAHLE_GEOMETRY["trim"]
    # A single scale anchors the center and protects proportions when source
    # dimensions are rounded to whole pixels. Output bleed only sets the clip.
    mm_per_pixel = max((trim_width + 2 * source_bleed) / artwork.width,
                       (trim_height + 2 * source_bleed) / artwork.height)
    if output_bleed > source_bleed:
        artwork = mirror_artwork_edges(artwork, math.ceil((output_bleed - source_bleed) / mm_per_pixel))
    width_mm, height_mm = artwork.width * mm_per_pixel, artwork.height * mm_per_pixel
    artwork.thumbnail((math.ceil(width_mm * 600 / 25.4), math.ceil(height_mm * 600 / 25.4)), Image.Resampling.LANCZOS)
    encoded = io.BytesIO()
    artwork.save(encoded, "JPEG", quality=100)
    xobject = EncodedStreamObject()
    xobject._data = encoded.getvalue()
    xobject.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Image"),
                    NameObject("/Width"): NumberObject(artwork.width), NameObject("/Height"): NumberObject(artwork.height),
                    NameObject("/ColorSpace"): NameObject("/DeviceRGB"), NameObject("/BitsPerComponent"): NumberObject(8),
                    NameObject("/Filter"): NameObject("/DCTDecode")})
    return xobject, metadata, (width_mm, height_mm)


def pdf_coordinates(*values):
    return " ".join(f"{value * POINTS_PER_MM:.6f}" for value in values)


def stroke_dahle_guides(commands, paths, geometry, *, stroke_rgb=None):
    outline, center = "1 G", "0 G"
    if stroke_rgb is not None:
        outline = "0 G"
        center = " ".join(str(channel) for channel in stroke_rgb) + " RG"
    commands.append("q 0 J")
    for color, width in ((outline, geometry["outlineWidth"]), (center, geometry["strokeWidth"])):
        commands.extend((f"{color} {pdf_coordinates(width)} w", *paths, "S"))
    commands.append("Q")


def dahle_corner_paths(cells, cell_width, cell_height, bleed, geometry):
    inset = bleed + geometry["trimRadius"]
    radius = geometry["trimRadius"] + geometry["offset"]
    start, end = (math.radians(angle) for angle in geometry["angles"])
    tangent = 4 / 3 * radius * math.tan((end - start) / 4)
    x0, y0 = radius * math.cos(start), radius * math.sin(start)
    x3, y3 = radius * math.cos(end), radius * math.sin(end)
    # A short cubic arc offset parallel to the R3 trim.
    # The endpoints stay inside the strip and the center survives row drift.
    curve = ((x0, y0), (x0 - tangent * math.sin(start), y0 + tangent * math.cos(start)),
             (x3 + tangent * math.sin(end), y3 - tangent * math.cos(end)), (x3, y3))
    paths = []
    for left, bottom in cells:
        for x, sign_x in ((left + inset, -1), (left + cell_width - inset, 1)):
            for y, sign_y in ((bottom + inset, -1), (bottom + cell_height - inset, 1)):
                p0, p1, p2, p3 = [(x + sign_x * dx, y + sign_y * dy) for dx, dy in curve]
                paths.append(f"{pdf_coordinates(*p0)} m {pdf_coordinates(*p1, *p2, *p3)} c")
    return paths


def generate_dahle_sheet(cards, output, double_faced, alignment_marks=False, cut_guides=False):
    page_width, page_height = DAHLE_GEOMETRY["page"]
    trim_width, trim_height = DAHLE_GEOMETRY["trim"]
    columns, rows, bleed = (DAHLE_GEOMETRY[key] for key in ("columns", "rows", "bleed"))
    cell_width, cell_height = trim_width + 2 * bleed, trim_height + 2 * bleed
    side, top = (page_width - columns * cell_width) / 2, (page_height - rows * cell_height) / 2
    tick_start, tick_end = DAHLE_GEOMETRY["tick"]
    row_cuts = [page_height - top - boundary * cell_height for boundary in range(rows + 1)]
    metadata = [{"id": card["id"]} for card in cards]
    writer = PdfWriter()
    for face in ("front", "back") if double_faced else ("front",):
        page = writer.add_blank_page(width=page_width * POINTS_PER_MM, height=page_height * POINTS_PER_MM)
        objects = DictionaryObject()
        commands = []
        alignment_boundaries = set()
        corner_cells = []
        for slot, card in enumerate(cards):
            path = card.get(f"{face}Path")
            if path is None:
                continue
            try:
                artwork, metadata[slot][face], (image_width, image_height) = dahle_face(path, card.get(f"{face}Source"), bleed)
            except ValueError as error:
                raise ValueError(f"Dahle artwork for {card.get('displayName') or card['id']} ({face}): {error}") from None
            row, column = divmod(slot, columns)
            if face == "back":
                column = columns - 1 - column  # A4 portrait, long-edge flip.
            if alignment_marks:
                alignment_boundaries.update(((row, column), (row, column + 1)))
            x = side + column * cell_width
            y = page_height - top - (row + 1) * cell_height
            if cut_guides:
                corner_cells.append((x, y))
            image_x, image_y = x + (cell_width - image_width) / 2, y + (cell_height - image_height) / 2
            name = f"/Card{slot + 1}"
            objects[NameObject(name)] = writer._add_object(artwork)
            commands.extend(("q", f"{pdf_coordinates(x, y, cell_width, cell_height)} re W n",
                             f"{pdf_coordinates(image_width)} 0 0 {pdf_coordinates(image_height, image_x, image_y)} cm",
                             f"{name} Do", "Q"))
        if cut_guides:
            # The cutter makes four transverse cuts across the sheet. These
            # stay at the same positions on both faces and on partial sheets.
            right = page_width - tick_start
            strip_paths = [f"{pdf_coordinates(tick_start, y)} m {pdf_coordinates(right, y)} l" for y in row_cuts]
            strip = DAHLE_GEOMETRY["stripGuideStroke"]
            stroke_dahle_guides(commands, strip_paths, strip, stroke_rgb=strip["strokeRgb"])
            endpoints = DAHLE_GEOMETRY["stripGuideEndpoint"]
            endpoint_length = endpoints["length"]
            endpoint_paths = [f"{pdf_coordinates(start, y)} m {pdf_coordinates(end, y)} l" for y in row_cuts
                              for start, end in ((tick_start, tick_start + endpoint_length), (right - endpoint_length, right))]
            stroke_dahle_guides(commands, endpoint_paths, endpoints, stroke_rgb=strip["strokeRgb"])
            corners = DAHLE_GEOMETRY["cornerGuides"]
            corner_paths = dahle_corner_paths(corner_cells, cell_width, cell_height, bleed, corners)
            stroke_dahle_guides(commands, corner_paths, corners, stroke_rgb=corners["strokeRgb"])
        else:
            commands.extend(("q", "0 G", "0.5 w"))
            for y in row_cuts:
                for start, end in ((tick_start, tick_end), (page_width - tick_end, page_width - tick_start)):
                    commands.append(f"{pdf_coordinates(start, y)} m {pdf_coordinates(end, y)} l S")
            commands.append("Q")
        if alignment_boundaries:
            geometry = DAHLE_GEOMETRY["alignmentMarks"]
            near, far = geometry["stripEdgeOffsets"]
            paths = []
            # These boundaries are midway between the finished card edges. The
            # paired strokes keep the center legible across the feed direction.
            for row, boundary in sorted(alignment_boundaries):
                x = side + boundary * cell_width
                y = page_height - top - (row + 1) * cell_height
                for start, end in ((near, far), (cell_height - far, cell_height - near)):
                    paths.append(f"{pdf_coordinates(x, y + start)} m {pdf_coordinates(x, y + end)} l")
            stroke_dahle_guides(commands, paths, geometry)
        content = DecodedStreamObject()
        content.set_data(("\n".join(commands) + "\n").encode("ascii"))
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/XObject"): objects})
        page[NameObject("/Contents")] = writer._add_object(content)
    with open(output, "wb") as stream:
        writer.write(stream)
    return metadata


def generate_without_footer(source, args, *, registration_marks=True):
    # Silhouette Card Maker always draws its footer, even when --label is omitted.
    # In this isolated process, replace only the final page assembly step. Keep
    # its lossless portrait rotation and front/back order before PDF encoding.
    sys.path.insert(0, str(source))
    from create_pdf import cli
    from enums import Orientation
    import utilities
    import page_manager

    def append_pages(front_page, back_page, pages, _width, _height, _ppi_ratio,
                     _template, only_fronts, _label, orientation, _margin, _borderless):
        if orientation == Orientation.PORTRAIT:
            front_page = front_page.rotate(90, expand=True)
            back_page = back_page.rotate(90, expand=True)
        pages.append(front_page)
        if not only_fronts:
            pages.append(back_page)

    utilities.add_front_back_pages = append_pages
    if not registration_marks:
        generate_reg_mark = page_manager.generate_reg_mark

        def blank_registration(*args, **kwargs):
            # Preserve the size of the upstream canvas and its existing layout.
            with generate_reg_mark(*args, **kwargs) as marks:
                return Image.new(marks.mode, marks.size, "white")

        page_manager.generate_reg_mark = blank_registration
    cli.main(args=args, prog_name="create_pdf.py")


def generate_upstream_sheet(request, recipe, output, registration_marks):
    source, directory = Path(request["source"]), output.parent
    approved_geometry(source, recipe)
    cards = request["cards"]
    double_faced = request["doubleFaced"]
    for folder in ("front", "back", "double_sided"):
        (directory / folder).mkdir()
    metadata = []
    for index, card in enumerate(cards):
        item = {"id": card["id"], "front": image_copy(card["frontPath"], directory / "front" / f"{index:04d}")}
        if card.get("backPath"):
            item["back"] = image_copy(card["backPath"], directory / "double_sided" / f"{index:04d}")
        metadata.append(item)
    command = [sys.executable, "-B", str(Path(__file__).resolve()), "upstream", str(source)]
    if not registration_marks:
        command.append("--omit-registration-marks")
    args = ["--front_dir_path", str(directory / "front"),
            "--back_dir_path", str(directory / "back"), "--double_sided_dir_path", str(directory / "double_sided"),
            "--output_path", str(output), "--card_size", "standard", "--paper_size", request.get("paperSize", "letter"), "--registration", "3",
            "--ppi", "600", "--quality", "100", "--crop", "1mm", "--fit", "stretch"]
    if recipe in PORTRAIT_PRESETS:
        args.append("--borderless")
    for slot in SKIPPED_SLOTS.get(recipe, ()):
        args.extend(["--skip", str(slot)])
    if not double_faced:
        args.append("--only_fronts")
    subprocess.run([*command, *args], cwd=directory, stdin=subprocess.DEVNULL, check=True, timeout=90)
    validate_pdf(output, 2 if double_faced else 1, recipe, upstream=True)
    # The validated PDF and metadata are self-contained. Source artwork remains
    # in the job staging area, so do not retain another copy for every sheet.
    for folder in ("front", "back", "double_sided"):
        shutil.rmtree(directory / folder)
    return metadata


def dahle_guide_settings(request, recipe):
    alignment_marks = request.get("dahleAlignmentMarks", False)
    cut_guides = request.get("dahleCutGuides", False)
    if not isinstance(alignment_marks, bool) or (alignment_marks and recipe != DAHLE_A4_PUNCH):
        raise ValueError("Die-cutter alignment marks are a Dahle-only option")
    if not isinstance(cut_guides, bool) or (cut_guides and recipe != DAHLE_A4_PUNCH):
        raise ValueError("Strip cut lines and R3 corner guides are a Dahle-only option")
    if alignment_marks and cut_guides:
        raise ValueError("Choose either Dahle alignment marks or Dahle cut guides")
    return alignment_marks, cut_guides


def chunk(request):
    directory = Path(request["directory"])
    recipe = paper_key(request)
    requested_marks = request.get("registrationMarks", True)
    if not isinstance(requested_marks, bool):
        raise ValueError("Registration marks must be enabled or disabled")
    registration_marks = recipe != DAHLE_A4_PUNCH and requested_marks
    alignment_marks, cut_guides = dahle_guide_settings(request, recipe)
    cards = request["cards"]
    if not 1 <= len(cards) <= len(usable_slots(recipe)):
        raise ValueError("Each generator invocation must contain one sheet at most")
    sides = [bool(card.get("backPath")) for card in cards]
    double_faced = request["doubleFaced"]
    mixed = request.get("sheetPacking") == "double-faced-first"
    if double_faced != any(sides) or (mixed and sides != sorted(sides)) or (not mixed and double_faced != all(sides)):
        raise ValueError("Sheet faces must match the requested pass and slot order")
    output = directory / "sheet.pdf"
    if recipe == DAHLE_A4_PUNCH:
        metadata = generate_dahle_sheet(cards, output, double_faced, alignment_marks, cut_guides)
    else:
        metadata = generate_upstream_sheet(request, recipe, output, registration_marks)
    identify_pages(output, request["printedIdentification"], request["pageLabels"], recipe,
                   refeed_front=double_faced and recipe != DAHLE_A4_PUNCH, proof_scale=request.get("proofScale", False))
    validate_pdf(output, 2 if double_faced else 1, recipe)
    result = {"images": metadata, "registrationMarks": registration_marks}
    if alignment_marks:
        result["dahleAlignmentMarks"] = True
    if cut_guides:
        result["dahleCutGuides"] = True
    (directory / "result.json").write_text(json.dumps(result))


def merge(request):
    recipe = paper_key(request)
    if recipe == DAHLE_A4_PUNCH:
        title, creator = "CLC A4 3x3 - Dahle 550 + 63x88 R3 Punch", "CLC"
    else:
        title = f"CLC household-{recipe}-v{APPROVED_PAPER[recipe]['version']}"
        creator = "CLC / Silhouette Card Maker"
    output = Path(request["output"])
    with tempfile.TemporaryDirectory(prefix=".merge-", dir=output.parent) as temporary:
        metadata = Path(temporary) / "metadata.pdf"
        merged = Path(temporary) / "merged.pdf"
        writer = PdfWriter()
        writer.add_metadata({"/Title": title, "/Creator": creator})
        writer.write(metadata)
        # qpdf copies streams from the sheet files on disk as it writes the
        # output. Preserve the artwork bytes, resource dictionaries, and page order.
        inputs = [f"--file={filename}" for filename in request["inputs"]]
        subprocess.run(["qpdf", "--suppress-recovery", "--stream-data=preserve", "--keep-files-open=n",
                        "--remove-unreferenced-resources=no", "--deterministic-id", str(metadata),
                        "--pages", *inputs, "--", str(merged)], stdin=subprocess.DEVNULL, check=True, timeout=105)
        validate_pdf(merged, request["pageCount"], recipe)
        merged.replace(output)


def proof(request):
    recipe = paper_key(request)
    alignment_marks, cut_guides = dahle_guide_settings(request, recipe)
    directory = Path(request["directory"])
    cards = []
    width, height = PORTRAIT_CARD["width"], PORTRAIT_CARD["height"]
    number = ImageFont.load_default(78)
    body = ImageFont.load_default(31)
    for slot in usable_slots(recipe):
        file = directory / f"proof-{slot}.png"
        with Image.new("RGB", (width, height), "#aa492c") as artwork:
            marks = ImageDraw.Draw(artwork)
            marks.rectangle((22, 22, width - 23, height - 23), fill="#fbf7ee")
            marks.rectangle((60, 60, width - 61, height - 61), outline="#12384a", width=4)
            marks.line((width / 2, 112, width / 2, 197), fill="#12384a", width=5)
            marks.polygon(((width / 2, 104), (width / 2 - 14, 128), (width / 2 + 14, 128)), fill="#12384a")
            for y, text, font in [(365, f"Slot {slot + 1}", number), (478, "63 x 88 mm after cutting", body),
                                  (627, "Keep the dark frame intact.", body), (689, "Check cut edges for white slivers.", body)]:
                marks.text((width / 2, y), text, font=font, fill="#12384a", anchor="mm")
            artwork.save(file)
        cards.append({"id": f"proof-{slot}", "frontPath": str(file), "frontSource": "scryfall"})
    mark_label = "Dahle row ticks" if recipe == DAHLE_A4_PUNCH else (
        "Cameo registration marks" if request["registrationMarks"] else "No registration marks")
    if alignment_marks:
        mark_label += " + die-cutter alignment marks"
    if cut_guides:
        mark_label = "Dahle strip cut lines + R3 corner guides"
    identification = {"version": 1, "requesterName": "Paper proof",
                      "batchName": f"{request['proofRecipe']} | {request['proofRevision']}"}
    chunk({**request, "cards": cards, "doubleFaced": False, "proofScale": True, "printedIdentification": identification,
           "pageLabels": [{"page": 1, "phase": "fronts", "label": mark_label}]})


def smoke(source, directory):
    directory.mkdir()
    cards = []
    for index in range(9):
        paths = []
        for face, color in (("front", (30 + index * 20, 90, 180)), ("back", (180, 30 + index * 20, 60))):
            filename = directory / f"{index}-{face}.png"
            artwork = Image.new("RGB", (744, 1039), color)
            ImageDraw.Draw(artwork).rectangle((0, 160, 743, 280), fill="white")
            artwork.save(filename)
            paths.append(str(filename))
        cards.append({"id": str(index), "frontPath": paths[0], "backPath": paths[1]})
    for recipe in APPROVED_PAPER:
        smoke_paper(source, directory, cards[:len(usable_slots(recipe))], recipe)
    smoke_dahle(directory, cards)


def smoke_dahle(directory, cards):
    working = directory / DAHLE_A4_PUNCH
    working.mkdir()
    paper = {"paperSize": "a4", "printPreset": DAHLE_A4_PUNCH}
    chunk({"directory": str(working), **paper, "cards": cards, "doubleFaced": True, "dahleCutGuides": True,
           "printedIdentification": {"version": 1, "requesterName": "CLC runtime check", "batchName": "Dahle punch layout"},
           "pageLabels": [{"page": 1, "phase": "fronts", "label": "CLC runtime check"},
                          {"page": 2, "phase": "backs", "label": "CLC runtime check"}]})
    if json.loads((working / "result.json").read_text()).get("dahleCutGuides") is not True:
        raise ValueError("Dahle punch layout did not confirm cut guides")
    reader = PdfReader(working / "sheet.pdf", strict=True)
    for page, face in zip(reader.pages, ("FRONT", "BACK")):
        if len(page.images) != len(cards) or f"| {face}" not in page.extract_text():
            raise ValueError(f"Dahle punch layout did not generate all {face} card images")
    reader.close()
    merge({"inputs": [str(working / "sheet.pdf")], "output": str(working / "merged.pdf"), **paper, "pageCount": 2})


def smoke_paper(source, directory, cards, recipe):
    paper = APPROVED_PAPER[recipe]
    portrait = recipe in PORTRAIT_PRESETS
    centered = recipe == CROWNED_LANDSCAPE
    slots = usable_slots(recipe)
    columns = len(paper["x"])
    request_paper = {"paperSize": "a4", "printPreset": recipe} if portrait or centered else {"paperSize": recipe}

    def pixel(raster, slot, local_y, expected):
        point = ((paper["x"][slot % columns] + 372) * 2, (paper["y"][slot // columns] + local_y) * 2)
        if any(abs(a - b) > 3 for a, b in zip(raster.getpixel(point), expected)):
            raise ValueError(f"Upstream changed card ordering, face pairing, orientation or skipped slots for {paper['name']}")

    def read_raster(page, registration_marks):
        image = page.images[0].image
        if portrait:
            image = image.transpose(Image.Transpose.ROTATE_270)
            footer = (image.width // 4, image.height - 120, image.width * 3 // 4, image.height)
        else:
            footer = (image.width - 250, image.height // 4, image.width, image.height * 3 // 4)
        if any(low < 245 for low, _ in image.crop(footer).getextrema()):
            raise ValueError(f"Unexpected artwork in the former footer area for {paper['name']}")
        pixels_per_mm = 600 / 25.4
        inset = round((PORTRAIT_MARKS["inset"] if portrait else 10) * pixels_per_mm)
        square_center = inset + round(2.5 * pixels_per_mm)
        arm = inset + round(4 * pixels_per_mm)
        mark_points = ((square_center, square_center), (image.width - inset, arm), (arm, image.height - inset))
        for point in mark_points:
            color = image.getpixel(point)
            if (registration_marks and max(color) > 48) or (not registration_marks and min(color) < 245):
                raise ValueError(f"Unexpected registration mark output for {paper['name']}")
        if recipe == CROWNED_PORTRAIT_SIX:
            # The previous row's bleed may extend into the gutter. Inspect the
            # empty card row itself, above the bottom marks.
            start = paper["y"][-1] * 2
            end = (paper["y"][-1] + PORTRAIT_CARD["height"]) * 2
            if any(low < 252 for low, _ in image.crop((0, start, image.width, end)).getextrema()):
                raise ValueError("The bottom Crowned A4 Portrait 3×2 card row must stay blank on both faces")
        return image

    mixed_backs = 1 if portrait else 2
    for side_mode, first_back in (("ordinary", len(cards)), ("dfc", 0), ("mixed", len(cards) - mixed_backs)):
        double_faced = first_back < len(cards)
        registration_marks = side_mode != "mixed"
        working = directory / f"{recipe}-{side_mode}"
        working.mkdir()
        sheet_cards = [card if index >= first_back else {"id": card["id"], "frontPath": card["frontPath"]}
                       for index, card in enumerate(cards)]
        packing = {"sheetPacking": "double-faced-first"} if side_mode == "mixed" else {}
        chunk({"source": str(source), "directory": str(working),
               "printedIdentification": {"version": 1, "requesterName": "CLC runtime check", "batchName": "Approved geometry test"},
               "pageLabels": [{"page": 1, "phase": "fronts", "label": "CLC runtime check"}] + (
                   [{"page": 2, "phase": "backs", "label": "CLC runtime check"}] if double_faced else []),
               **request_paper, **packing, "doubleFaced": double_faced, "cards": sheet_cards,
               "registrationMarks": registration_marks})
        reader = PdfReader(working / "sheet.pdf", strict=True)
        if ("REFEED FOR BACK" in reader.pages[0].extract_text()) != double_faced:
            raise ValueError("Generated front page does not identify which sheets need refeeding")
        raster = read_raster(reader.pages[0], registration_marks)
        if not portrait and not centered:
            pixel(raster, 4, 519, (255, 255, 255))
        for index, slot in enumerate(slots):
            pixel(raster, slot, 519, (30 + index * 20, 90, 180))
            pixel(raster, slot, 230, (255, 255, 255))
        if double_faced:
            if "REFEED FOR BACK" in reader.pages[1].extract_text():
                raise ValueError("Generated back page has a front-only refeed instruction")
            raster = read_raster(reader.pages[1], registration_marks)
            if not portrait and not centered:
                pixel(raster, 0, 519, (255, 255, 255))
            for index, slot in enumerate(slots):
                row, column = divmod(slot, columns)
                back_slot = row * columns + (columns - 1 - column) if portrait else (1 - row) * columns + column
                color = (180, 30 + index * 20, 60) if index >= first_back else (255, 255, 255)
                pixel(raster, back_slot, 519, color)
                pixel(raster, back_slot, 230 if portrait else 800, (255, 255, 255))
        # Exercise the merger as part of activation, too.
        merge({"inputs": [str(working / "sheet.pdf")], "output": str(working / "merged.pdf"),
               **request_paper, "pageCount": 2 if double_faced else 1})


if __name__ == "__main__":
    if sys.argv[1] == "smoke":
        smoke(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1] == "chunk":
        chunk(json.loads(Path(sys.argv[2]).read_text()))
    elif sys.argv[1] == "merge":
        merge(json.loads(Path(sys.argv[2]).read_text()))
    elif sys.argv[1] == "proof":
        proof(json.loads(Path(sys.argv[2]).read_text()))
    elif sys.argv[1] == "upstream":
        args = sys.argv[3:]
        omit_marks = args[0] == "--omit-registration-marks"
        generate_without_footer(Path(sys.argv[2]), args[1:] if omit_marks else args, registration_marks=not omit_marks)
    else:
        raise ValueError("Unknown CLC print helper operation")
