"""Upstream creates every sheet; CLC adds margin identification without touching artwork."""
import hashlib
import io
import gc
import json
from pathlib import Path
import shutil
import subprocess
import sys
import warnings

from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject

CROWNED_LANDSCAPE = "crowned-a4-landscape"
CROWNED_PORTRAIT = "crowned-a4"
CROWNED_PORTRAIT_SIX = "crowned-a4-portrait-six"
PORTRAIT_PRESETS = {CROWNED_PORTRAIT, CROWNED_PORTRAIT_SIX}
CROWNED_LANDSCAPE_GEOMETRY = json.loads(Path(__file__).with_name("crownedLandscapeGeometry.json").read_text())
CROWNED_PORTRAIT_GEOMETRY = json.loads(Path(__file__).with_name("crownedPortraitGeometry.json").read_text())
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


def paper_key(request):
    size = request.get("paperSize", "letter")
    preset = request.get("printPreset")
    if preset is None and size in ("letter", "a4"):
        return size
    if preset in (CROWNED_PORTRAIT, CROWNED_PORTRAIT_SIX, CROWNED_LANDSCAPE) and size == "a4":
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


def image_copy(source, destination):
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
    with Image.open(io.BytesIO(data)) as image:
        image.load()  # Detect incomplete JPEG pixel data before calling upstream.
        metadata = {"sha256": hashlib.sha256(data).hexdigest(), "width": image.width, "height": image.height,
                    "mode": image.mode, "hasIccProfile": bool(image.info.get("icc_profile"))}
        extension = ".jpg" if image.format == "JPEG" else ".png"
    destination.with_suffix(extension).write_bytes(data)
    return metadata


def validate_pdf(filename, count, recipe, *, upstream=False):
    paper = APPROVED_PAPER[recipe]
    width, height = paper["raster_pixels"]
    portrait = recipe in PORTRAIT_PRESETS and not upstream
    page_width, page_height = (height, width) if portrait else (width, height)
    orientation = "portrait" if portrait else "landscape"
    media_box = [0, 0, page_width * 72 / 600, page_height * 72 / 600]
    # Passing a filename makes pypdf read the entire file into BytesIO. A file stream
    # plus per-page cache eviction keeps validation proportional to one sheet.
    with open(filename, "rb") as stream:
        reader = PdfReader(stream, strict=True)
        if len(reader.pages) != count:
            raise ValueError(f"Expected {count} pages, got {len(reader.pages)}")
        for page in reader.pages:
            actual_box = list(map(float, page.mediabox))
            if actual_box != media_box or page.rotation:
                raise ValueError(f"Generated PDF does not have unrotated {orientation} {paper['name']} pages")
            objects = page["/Resources"]["/XObject"].get_object()
            images = [item.get_object() for item in objects.values() if item.get_object().get("/Subtype") == "/Image"]
            if len(images) != 1 or images[0]["/Width"] != width or images[0]["/Height"] != height:
                raise ValueError("Generated PDF does not contain the expected 600 PPI page image")
            if images[0]["/ColorSpace"] != "/DeviceRGB":
                raise ValueError("Upstream changed its output color space")
            reader.resolved_objects.clear()
        reader.close()


def identify_pages(filename, identification, labels, recipe="letter", *, refeed_front=False):
    """Add vector identification in the approved top margin.

    Card pixels start at least 46.56pt below the top edge; the marks are at the
    outer corners. Our three lines stay within the top 42pt and clear of both.
    Existing 600ppi DeviceRGB image streams are copied without recompression.
    """
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
            lines = [f"Queued by: {values[0]}", f"Batch: {values[1]}",
                     f"{label} | {'FRONT' if item['phase'] == 'fronts' else 'BACK'}"]
            if refeed_front and item["phase"] == "fronts":
                lines[-1] += " | REFEED FOR BACK"
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
            commands = ["q", "0 g", "BT", "/CLCPageIdentity 8 Tf"]
            # Keep the label outside the registration corners and card bleed.
            offsets = (16, 25, 34) if portrait else (20, 30, 40)
            for offset, text in zip(offsets, lines):
                commands.extend((f"1 0 0 1 66 {top - offset:g} Tm", f"<{text.encode('ascii').hex()}> Tj"))
            commands.extend(("ET", "Q"))
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
    paper = APPROVED_PAPER[recipe]
    return [slot for slot in range(len(paper["x"]) * len(paper["y"])) if slot not in SKIPPED_SLOTS.get(recipe, ())]


def chunk(request):
    source, directory = Path(request["source"]), Path(request["directory"])
    paper_size = request.get("paperSize", "letter")
    recipe = paper_key(request)
    approved_geometry(source, recipe)
    cards = request["cards"]
    if not 1 <= len(cards) <= len(usable_slots(recipe)):
        raise ValueError("Each generator invocation must contain one sheet at most")
    sides = [bool(card.get("backPath")) for card in cards]
    double_faced = request["doubleFaced"]
    mixed = request.get("sheetPacking") == "double-faced-first"
    if double_faced != any(sides) or (mixed and sides != sorted(sides)) or (not mixed and double_faced != all(sides)):
        raise ValueError("Sheet faces must match the requested pass and upstream slot order")
    for folder in ("front", "back", "double_sided"):
        (directory / folder).mkdir()
    metadata = []
    for index, card in enumerate(cards):
        item = {"id": card["id"], "front": image_copy(card["frontPath"], directory / "front" / f"{index:04d}")}
        if card.get("backPath"):
            item["back"] = image_copy(card["backPath"], directory / "double_sided" / f"{index:04d}")
        metadata.append(item)
    output = directory / "sheet.pdf"
    command = [sys.executable, str(source / "create_pdf.py")]
    args = ["--front_dir_path", str(directory / "front"),
            "--back_dir_path", str(directory / "back"), "--double_sided_dir_path", str(directory / "double_sided"),
            "--output_path", str(output), "--card_size", "standard", "--paper_size", paper_size, "--registration", "3",
            "--ppi", "600", "--quality", "100", "--crop", "1mm", "--fit", "stretch",
            "--label", request["label"]]
    if recipe in PORTRAIT_PRESETS:
        args.append("--borderless")
    for slot in SKIPPED_SLOTS.get(recipe, ()):
        args.extend(["--skip", str(slot)])
    if not double_faced:
        args.append("--only_fronts")
    subprocess.run([*command, *args], cwd=directory, stdin=subprocess.DEVNULL, check=True, timeout=90)
    page_count = 2 if double_faced else 1
    validate_pdf(output, page_count, recipe, upstream=True)
    identify_pages(output, request["printedIdentification"], request["pageLabels"], recipe, refeed_front=double_faced)
    validate_pdf(output, page_count, recipe)
    (directory / "result.json").write_text(json.dumps({"images": metadata}))
    # The validated PDF and metadata are self-contained. Source artwork remains
    # in the job staging area, so do not retain another copy for every sheet.
    for folder in ("front", "back", "double_sided"):
        shutil.rmtree(directory / folder)


def merge(request):
    recipe = paper_key(request)
    paper = APPROVED_PAPER[recipe]
    writer = PdfWriter()
    for filename in request["inputs"]:
        with open(filename, "rb") as stream:
            reader = PdfReader(stream, strict=True)
            writer.append(reader, import_outline=False)
            reader.close()
    writer.add_metadata({"/Title": f"CLC household-{recipe}-v{paper['version']}", "/Creator": "CLC / Silhouette Card Maker"})
    with open(request["output"], "wb") as stream:
        writer.write(stream)
    # PdfWriter.close() is a no-op. Release its compressed image objects before
    # reopening the output, rather than retaining several copies of a whole deck.
    del writer, reader
    gc.collect()
    validate_pdf(request["output"], request["pageCount"], recipe)


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

    def read_raster(page):
        image = page.images[0].image
        if centered:
            # Check the A4 v5 registration square and both L marks with every slot filled.
            for x_mm, y_mm in ((12.5, 12.5), (287, 16), (10, 194)):
                point = (round(x_mm * 600 / 25.4), round(y_mm * 600 / 25.4))
                if max(image.getpixel(point)) > 48:
                    raise ValueError("Centered A4 registration marks moved out of their approved positions")
        if not portrait:
            return image
        image = image.transpose(Image.Transpose.ROTATE_270)
        # All three marks must survive the Epson's normal ~3 mm margin.
        for x_mm, y_mm in ((5.5, 5.5), (206.5, 9), (9, 293.5)):
            point = (round(x_mm * 600 / 25.4), round(y_mm * 600 / 25.4))
            if max(image.getpixel(point)) > 48:
                raise ValueError("Crowned registration marks moved out of their approved positions")
        if recipe == CROWNED_PORTRAIT_SIX:
            # The previous row's bleed may extend into the gutter. Inspect the
            # empty card row itself, above the bottom marks and upstream label.
            start = paper["y"][-1] * 2
            end = (paper["y"][-1] + PORTRAIT_CARD["height"]) * 2
            if any(low < 252 for low, _ in image.crop((0, start, image.width, end)).getextrema()):
                raise ValueError("The bottom Crowned A4 Portrait 3×2 card row must stay blank on both faces")
        return image

    mixed_backs = 1 if portrait else 2
    for side_mode, first_back in (("ordinary", len(cards)), ("dfc", 0), ("mixed", len(cards) - mixed_backs)):
        double_faced = first_back < len(cards)
        working = directory / f"{recipe}-{side_mode}"
        working.mkdir()
        sheet_cards = [card if index >= first_back else {"id": card["id"], "frontPath": card["frontPath"]}
                       for index, card in enumerate(cards)]
        packing = {"sheetPacking": "double-faced-first"} if side_mode == "mixed" else {}
        chunk({"source": str(source), "directory": str(working), "label": "CLC runtime check",
               "printedIdentification": {"version": 1, "requesterName": "CLC runtime check", "batchName": "Approved geometry test"},
               "pageLabels": [{"page": 1, "phase": "fronts", "label": "CLC runtime check"}] + (
                   [{"page": 2, "phase": "backs", "label": "CLC runtime check"}] if double_faced else []),
               **request_paper, **packing, "doubleFaced": double_faced, "cards": sheet_cards})
        reader = PdfReader(working / "sheet.pdf", strict=True)
        if ("REFEED FOR BACK" in reader.pages[0].extract_text()) != double_faced:
            raise ValueError("Generated front page does not identify which sheets need refeeding")
        raster = read_raster(reader.pages[0])
        if not portrait and not centered:
            pixel(raster, 4, 519, (255, 255, 255))
        for index, slot in enumerate(slots):
            pixel(raster, slot, 519, (30 + index * 20, 90, 180))
            pixel(raster, slot, 230, (255, 255, 255))
        if double_faced:
            if "REFEED FOR BACK" in reader.pages[1].extract_text():
                raise ValueError("Generated back page has a front-only refeed instruction")
            raster = read_raster(reader.pages[1])
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
    else:
        raise ValueError("Unknown CLC print helper operation")
