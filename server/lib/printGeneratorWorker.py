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

# Generated 600 PPI sheets are 33.66 megapixels; source cards have a smaller explicit cap.
Image.MAX_IMAGE_PIXELS = 34_000_000
MAX_SOURCE_PIXELS = 16_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
MAX_IMAGE_BYTES = 20 * 1024 * 1024


def approved_geometry(source):
    sys.path.insert(0, str(source))
    import page_manager
    from enums import Orientation
    config = json.loads((source / "assets/layouts.json").read_text())
    layout = config["layouts"]["letter"]["standard"]["default"]
    required = {"orientation": "landscape", "version": 6, "num_rows": 2, "num_cols": 4,
                "registration": {"length": "8.04mm"}}
    if layout != required or config["ppi"] != 300:
        raise ValueError("Upstream changed the approved letter-standard-v6 layout")
    if config["card_sizes"]["standard"]["width"] != "63mm" or config["card_sizes"]["standard"]["height"] != "88mm":
        raise ValueError("Upstream changed the approved card dimensions")
    if config["defaults"]["registration"]["default"] != {"inset": "10mm", "thickness": "1mm", "length": "5mm"}:
        raise ValueError("Upstream changed the approved registration settings")
    if config["paper_sizes"]["letter"]["width"] != "11in" or config["paper_sizes"]["letter"]["height"] != "8.5in":
        raise ValueError("Upstream changed Letter paper dimensions")
    geometry = page_manager.generate_layout(orientation=Orientation.LANDSCAPE, card_width="63mm", card_height="88mm",
        paper_width="11in", paper_height="8.5in", inset="10mm", length="6.5mm", ppi=300)
    actual = [geometry.card_width_px, geometry.card_height_px, geometry.paper_width_px, geometry.paper_height_px,
              geometry.x_pos, geometry.y_pos]
    if actual != [744, 1039, 3300, 2550, [140, 899, 1658, 2417], [228, 1282]]:
        raise ValueError("Upstream geometry is incompatible with the approved v6 cutting template")


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


def validate_pdf(filename, count):
    # Passing a filename makes pypdf read the entire file into BytesIO. A file stream
    # plus per-page cache eviction keeps validation proportional to one sheet.
    with open(filename, "rb") as stream:
        reader = PdfReader(stream, strict=True)
        if len(reader.pages) != count:
            raise ValueError(f"Expected {count} pages, got {len(reader.pages)}")
        for page in reader.pages:
            if list(map(float, page.mediabox)) != [0, 0, 792, 612] or page.rotation:
                raise ValueError("Generated PDF does not have unrotated landscape Letter pages")
            objects = page["/Resources"]["/XObject"].get_object()
            images = [item.get_object() for item in objects.values() if item.get_object().get("/Subtype") == "/Image"]
            if len(images) != 1 or images[0]["/Width"] != 6600 or images[0]["/Height"] != 5100:
                raise ValueError("Generated PDF does not contain the expected 600 PPI page image")
            if images[0]["/ColorSpace"] != "/DeviceRGB":
                raise ValueError("Upstream changed its output color space")
            reader.resolved_objects.clear()
        reader.close()


def identify_pages(filename, identification, labels):
    """Add vector text only in the approved v6 top-center margin.

    Card pixels start 54.72pt below the top edge; registration marks are at the
    outer corners. Our three 8pt lines occupy x=66..726, y=570..600, clear of both.
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
            resources = DictionaryObject(page["/Resources"])
            fonts = DictionaryObject(resources.get("/Font", DictionaryObject()).get_object())
            if "/CLCPageIdentity" in fonts:
                raise ValueError("Generated PDF already contains CLC page identification")
            fonts[NameObject("/CLCPageIdentity")] = font
            resources[NameObject("/Font")] = fonts
            page[NameObject("/Resources")] = resources
            commands = ["q", "0 g", "BT", "/CLCPageIdentity 8 Tf"]
            for y, text in zip((592, 582, 572), lines):
                commands.extend((f"1 0 0 1 66 {y} Tm", f"<{text.encode('ascii').hex()}> Tj"))
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


def chunk(request):
    source, directory = Path(request["source"]), Path(request["directory"])
    approved_geometry(source)
    cards = request["cards"]
    if not 1 <= len(cards) <= 7:
        raise ValueError("Each generator invocation must contain one sheet at most")
    for folder in ("front", "back", "double_sided"):
        (directory / folder).mkdir()
    metadata = []
    for index, card in enumerate(cards):
        if bool(card.get("backPath")) != request["doubleFaced"]:
            raise ValueError("Ordinary cards and double-faced cards must be separate batches")
        item = {"id": card["id"], "front": image_copy(card["frontPath"], directory / "front" / f"{index:04d}")}
        if request["doubleFaced"]:
            item["back"] = image_copy(card["backPath"], directory / "double_sided" / f"{index:04d}")
        metadata.append(item)
    output = directory / "sheet.pdf"
    args = [sys.executable, str(source / "create_pdf.py"), "--front_dir_path", str(directory / "front"),
            "--back_dir_path", str(directory / "back"), "--double_sided_dir_path", str(directory / "double_sided"),
            "--output_path", str(output), "--card_size", "standard", "--paper_size", "letter", "--registration", "3",
            "--ppi", "600", "--quality", "100", "--crop", "1mm", "--skip", "4", "--fit", "stretch",
            "--label", request["label"]]
    if not request["doubleFaced"]:
        args.append("--only_fronts")
    subprocess.run(args, cwd=directory, stdin=subprocess.DEVNULL, check=True, timeout=90)
    validate_pdf(output, 2 if request["doubleFaced"] else 1)
    identify_pages(output, request["printedIdentification"], request["pageLabels"])
    validate_pdf(output, 2 if request["doubleFaced"] else 1)
    (directory / "result.json").write_text(json.dumps({"images": metadata}))
    # The validated PDF and metadata are self-contained. Source artwork remains
    # in the job staging area, so do not retain another copy for every sheet.
    for folder in ("front", "back", "double_sided"):
        shutil.rmtree(directory / folder)


def merge(request):
    writer = PdfWriter()
    for filename in request["inputs"]:
        with open(filename, "rb") as stream:
            reader = PdfReader(stream, strict=True)
            writer.append(reader, import_outline=False)
            reader.close()
    writer.add_metadata({"/Title": "CLC household-letter-v6", "/Creator": "CLC / Silhouette Card Maker"})
    with open(request["output"], "wb") as stream:
        writer.write(stream)
    # PdfWriter.close() is a no-op. Release its compressed image objects before
    # reopening the output, rather than retaining several copies of a whole deck.
    del writer, reader
    gc.collect()
    validate_pdf(request["output"], request["pageCount"])


def smoke(source, directory):
    directory.mkdir()
    cards = []
    for index in range(7):
        paths = []
        for face, color in (("front", (30 + index * 20, 90, 180)), ("back", (180, 30 + index * 20, 60))):
            filename = directory / f"{index}-{face}.png"
            artwork = Image.new("RGB", (744, 1039), color)
            ImageDraw.Draw(artwork).rectangle((0, 160, 743, 280), fill="white")
            artwork.save(filename)
            paths.append(str(filename))
        cards.append({"id": str(index), "frontPath": paths[0], "backPath": paths[1]})
    usable_slots = [0, 1, 2, 3, 5, 6, 7]
    def pixel(raster, slot, local_y, expected):
        point = (([140, 899, 1658, 2417][slot % 4] + 372) * 2,
                 ([228, 1282][slot // 4] + local_y) * 2)
        if any(abs(a - b) > 3 for a, b in zip(raster.getpixel(point), expected)):
            raise ValueError("Upstream changed card ordering, face pairing, orientation or skipped slots")
    for double_faced in (False, True):
        working = directory / ("dfc" if double_faced else "ordinary")
        working.mkdir()
        chunk({"source": str(source), "directory": str(working), "label": "CLC runtime check",
               "printedIdentification": {"version": 1, "requesterName": "CLC runtime check", "batchName": "Approved geometry test"},
               "pageLabels": [{"page": 1, "phase": "fronts", "label": "CLC runtime check"}] + (
                   [{"page": 2, "phase": "backs", "label": "CLC runtime check"}] if double_faced else []),
               "doubleFaced": double_faced, "cards": cards if double_faced else [
                   {"id": card["id"], "frontPath": card["frontPath"]} for card in cards]})
        reader = PdfReader(working / "sheet.pdf", strict=True)
        raster = reader.pages[0].images[0].image
        pixel(raster, 4, 519, (255, 255, 255))
        for index, slot in enumerate(usable_slots):
            pixel(raster, slot, 519, (30 + index * 20, 90, 180))
            pixel(raster, slot, 230, (255, 255, 255))
        if double_faced:
            raster = reader.pages[1].images[0].image
            pixel(raster, 0, 519, (255, 255, 255))
            for index, slot in enumerate(usable_slots):
                back_slot = slot + 4 if slot < 4 else slot - 4
                pixel(raster, back_slot, 519, (180, 30 + index * 20, 60))
                pixel(raster, back_slot, 800, (255, 255, 255))
        # Exercise the merger as part of activation, too.
        merge({"inputs": [str(working / "sheet.pdf")], "output": str(working / "merged.pdf"),
               "pageCount": 2 if double_faced else 1})


if __name__ == "__main__":
    if sys.argv[1] == "smoke":
        smoke(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1] == "chunk":
        chunk(json.loads(Path(sys.argv[2]).read_text()))
    elif sys.argv[1] == "merge":
        merge(json.loads(Path(sys.argv[2]).read_text()))
    else:
        raise ValueError("Unknown CLC print helper operation")
