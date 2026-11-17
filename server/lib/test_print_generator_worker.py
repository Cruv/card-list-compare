"""Margin-label regressions; run with the same pypdf/Pillow runtime as the worker."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject, RectangleObject
from PIL import Image, ImageDraw

from printGeneratorWorker import CROWNED_LANDSCAPE, DAHLE_A4_PUNCH, POINTS_PER_MM, chunk, dahle_face, identify_pages, merge, validate_pdf


class DahlePunchTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.paper = {"paperSize": "a4", "printPreset": DAHLE_A4_PUNCH}
        self.front_colors = [(20 + index * 21, 45, 90) for index in range(9)]
        self.back_colors = [(40, 60, 20 + index * 21) for index in range(9)]
        self.cards = []
        for index, (front_color, back_color) in enumerate(zip(self.front_colors, self.back_colors)):
            card = {"id": str(index)}
            for face, color in (("front", front_color), ("back", back_color)):
                path = self.directory / f"{face}-{index}.png"
                image = Image.new("RGB", (315, 440), color)
                ImageDraw.Draw(image).rectangle((15, 28, 300, 48), fill="white")
                image.save(path)
                card[f"{face}Path"] = str(path)
                card[f"{face}Source"] = "scryfall"
            self.cards.append(card)

    def render(self, name, cards, *, double_faced=False, mixed=False):
        directory = self.directory / name
        directory.mkdir()
        packing = {"sheetPacking": "double-faced-first"} if mixed else {}
        chunk({"directory": str(directory), **self.paper, **packing, "cards": cards, "doubleFaced": double_faced,
               "registrationMarks": True,
               "printedIdentification": {"version": 1, "requesterName": "Fixture", "batchName": "Dahle test"},
               "pageLabels": [{"page": 1, "phase": "fronts", "label": "CLC full or partial"}] +
               ([{"page": 2, "phase": "backs", "label": "CLC full or partial"}] if double_faced else [])})
        result = json.loads((directory / "result.json").read_text())
        self.assertFalse(result["registrationMarks"])
        return directory / "sheet.pdf"

    @staticmethod
    def mm_operators(page, operator):
        return [tuple(round(float(value) / POINTS_PER_MM, 4) for value in operands)
                for operands, name in page.get_contents().operations if name == operator]

    def check_media_and_ticks(self, page):
        self.assertEqual(page.rotation, 0)
        self.assertAlmostEqual(float(page.mediabox.width) / POINTS_PER_MM, 210, places=5)
        self.assertAlmostEqual(float(page.mediabox.height) / POINTS_PER_MM, 297, places=5)
        y_positions = [283.5, 193.5, 103.5, 13.5]
        self.assertEqual(self.mm_operators(page, b"m"), [(x, y) for y in y_positions for x in (4.5, 203)])
        self.assertEqual(self.mm_operators(page, b"l"), [(x, y) for y in y_positions for x in (7, 205.5)])
        self.assertEqual(sum(operator == b"S" for _, operator in page.get_contents().operations), 8)
        label_positions = []
        page.extract_text(visitor_text=lambda text, cm, tm, font, size:
                          label_positions.append((tm, size)) if text.strip() else None)
        self.assertEqual(len(label_positions), 3)
        for position, size in label_positions:
            self.assertGreater((position[5] - size * 0.3) / POINTS_PER_MM, y_positions[0])

    def check_image(self, page, slot, color):
        image = page.images[f"/Card{slot + 1}"].image
        for point, expected in (((160, 220), color), ((160, 40), (255, 255, 255))):
            self.assertTrue(all(abs(channel - goal) <= 3 for channel, goal in zip(image.getpixel(point), expected)))

    def test_exact_a4_and_fixed_full_and_partial_page_geometry(self):
        fronts = [{key: value for key, value in card.items() if not key.startswith("back")} for card in self.cards]
        full = self.render("full", fronts)
        partial = self.render("partial", fronts[:4])
        output = self.directory / "fronts.pdf"
        merge({"inputs": [str(full), str(partial)], "output": str(output), "pageCount": 2, **self.paper})
        with PdfReader(output) as reader:
            for index, page in enumerate(reader.pages):
                self.check_media_and_ticks(page)
                positions = [(x, y, 65, 90) for y in (193.5, 103.5, 13.5) for x in (7.5, 72.5, 137.5)]
                occupied = 9 if index == 0 else 4
                self.assertEqual(self.mm_operators(page, b"re"), positions[:occupied])
                self.assertEqual(sum(operator == b"W" for _, operator in page.get_contents().operations), occupied)
                transforms = self.mm_operators(page, b"cm")
                self.assertEqual(transforms, [(65, 0, 0, 90, x, y) for x, y, _, _ in positions[:occupied]])
                for slot in range(occupied):
                    self.check_image(page, slot, self.front_colors[slot])

    def test_mirrors_columns_for_upright_long_edge_backs_and_keeps_single_placement(self):
        cards = [dict(card) for card in self.cards[:5]]
        cards[0].pop("backPath")
        filename = self.render("mixed", cards, double_faced=True, mixed=True)
        with PdfReader(filename) as reader:
            first, back = reader.pages
            for page in reader.pages:
                self.check_media_and_ticks(page)
            self.assertIn("Prepared by: Fixture", first.extract_text())
            self.assertNotIn("REFEED FOR BACK", first.extract_text())
            self.assertNotIn("REFEED FOR BACK", back.extract_text())
            self.assertEqual(self.mm_operators(back, b"re"), [(72.5, 193.5, 65, 90), (7.5, 193.5, 65, 90),
                                                             (137.5, 103.5, 65, 90), (72.5, 103.5, 65, 90)])
            self.assertEqual(len(back.images), 4)
            for slot in range(1, 5):
                self.check_image(back, slot, self.back_colors[slot])

    def test_uses_mpc_source_bleed_independently_of_the_output_clip(self):
        path = self.directory / "mpc.png"
        artwork = Image.new("RGB", (1387, 1887), "magenta")
        ImageDraw.Draw(artwork).rectangle((64, 64, 1323, 1823), fill="navy")
        artwork.save(path)
        for output_bleed in (0, 1, 2):
            _, metadata, (width, height) = dahle_face(path, "saved-mpc", output_bleed)
            self.assertEqual(metadata["sourceBleedMm"], 3.175)
            self.assertAlmostEqual(width, 69.35)
            self.assertAlmostEqual(height, 94.35)
        cards = [{"id": "mpc", "frontPath": str(path), "frontSource": "saved-mpc"}]
        with PdfReader(self.render("mpc", cards)) as reader:
            page = reader.pages[0]
            self.assertEqual(self.mm_operators(page, b"re"), [(7.5, 193.5, 65, 90)])
            self.assertEqual(self.mm_operators(page, b"cm"), [(69.35, 0, 0, 94.35, 5.325, 191.325)])
            width, _, _, height, x, y = self.mm_operators(page, b"cm")[0]
            self.assertAlmostEqual(width - 2 * 3.175, 63)
            self.assertAlmostEqual(height - 2 * 3.175, 88)
            self.assertAlmostEqual(x + 3.175, 8.5)
            self.assertAlmostEqual(y + 3.175, 194.5)
        Image.new("RGB", (300, 400), "red").save(path)
        with self.assertRaisesRegex(ValueError, "no recognized 63 × 88 mm trim geometry"):
            dahle_face(path, "saved-mpc", 1)

    def test_extends_trim_only_art_including_transparent_rounded_corners(self):
        path = self.directory / "scryfall.png"
        artwork = Image.new("RGBA", (315, 440), (0, 0, 0, 0))
        ImageDraw.Draw(artwork).rounded_rectangle((0, 0, 314, 439), radius=25, fill="navy")
        artwork.save(path)
        for output_bleed, expected in ((0, (63, 88)), (1, (65, 90)), (2, (67, 92))):
            _, metadata, dimensions = dahle_face(path, "scryfall", output_bleed)
            self.assertEqual(metadata["sourceBleedMm"], 0)
            self.assertEqual(dimensions, expected)
        cards = [{"id": "rounded", "frontPath": str(path), "frontSource": "scryfall"}]
        with PdfReader(self.render("rounded", cards)) as reader:
            image = reader.pages[0].images[0].image
            self.assertTrue(all(abs(channel - goal) <= 3 for channel, goal in zip(image.getpixel((0, 0)), (0, 0, 128))))


class PageIdentificationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.pdf = Path(self.directory.name) / "sheet.pdf"
        writer = PdfWriter()
        image = DecodedStreamObject()
        image.set_data(b"\x11\x22\x33")
        image.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Image"),
                      NameObject("/Width"): NumberObject(1), NameObject("/Height"): NumberObject(1),
                      NameObject("/ColorSpace"): NameObject("/DeviceRGB"), NameObject("/BitsPerComponent"): NumberObject(8)})
        image_ref = writer._add_object(image)
        for _ in range(2):
            page = writer.add_blank_page(width=792, height=612)
            page[NameObject("/Resources")] = DictionaryObject({NameObject("/XObject"): DictionaryObject({NameObject("/Artwork"): image_ref})})
            content = DecodedStreamObject()
            content.set_data(b"q 10 0 0 10 100 100 cm /Artwork Do Q\n")
            page[NameObject("/Contents")] = writer._add_object(content)
        with self.pdf.open("wb") as stream:
            writer.write(stream)
        self.identity = {"version": 1, "requesterName": "Denny", "batchName": "Jin Sakai"}
        self.labels = [{"page": 1, "phase": "fronts", "label": "CLC 1234abcd DFC 1/2"},
                       {"page": 2, "phase": "backs", "label": "CLC 1234abcd DFC 1/2"}]

    def test_tags_both_faces_without_changing_geometry_or_artwork(self):
        before = PdfReader(self.pdf)
        original = [page["/Resources"]["/XObject"]["/Artwork"].get_data() for page in before.pages]
        identify_pages(self.pdf, self.identity, self.labels)
        after = PdfReader(self.pdf)
        for index, page in enumerate(after.pages):
            self.assertEqual(list(page.mediabox), [0, 0, 792, 612])
            self.assertEqual(page.rotation, 0)
            image = page["/Resources"]["/XObject"]["/Artwork"]
            self.assertEqual(image["/ColorSpace"], "/DeviceRGB")
            self.assertEqual(hashlib.sha256(image.get_data()).hexdigest(), hashlib.sha256(original[index]).hexdigest())
            self.assertIn("Queued by: Denny", page.extract_text())
            self.assertIn("Batch: Jin Sakai", page.extract_text())
            self.assertIn(f"CLC 1234abcd DFC 1/2 | {'FRONT' if index == 0 else 'BACK'}", page.extract_text())

    def test_hostile_pdf_text_is_literal_and_maximum_names_fit_the_margin(self):
        self.identity.update(requesterName="(person) \\ <test>", batchName="W" * 96)
        identify_pages(self.pdf, self.identity, self.labels)
        reader = PdfReader(self.pdf)
        self.assertIn("Queued by: (person) \\ <test>", reader.pages[0].extract_text())
        for page in reader.pages:
            runs = []
            page.extract_text(visitor_text=lambda text, cm, tm, font, size: runs.append((text, tm, size)))
            for text, tm, size in runs:
                if not text.strip():
                    continue
                self.assertLessEqual(size, 7)
                self.assertEqual(tm[4], 66)
                self.assertIn(tm[5], (571, 578))
                self.assertLessEqual(tm[4] + len(text.rstrip("\n")) * size * 0.6, 726)

    def test_a4_labels_fit_each_side_and_paper_sizes_cannot_be_mixed(self):
        writer = PdfWriter(clone_from=self.pdf)
        for page in writer.pages:
            page.mediabox = RectangleObject([0, 0, 841.68, 595.2])
            image = page["/Resources"]["/XObject"]["/Artwork"]
            image[NameObject("/Width")] = NumberObject(7014)
            image[NameObject("/Height")] = NumberObject(4960)
        with self.pdf.open("wb") as stream:
            writer.write(stream)
        identify_pages(self.pdf, self.identity, self.labels)
        validate_pdf(self.pdf, 2, "a4")
        with self.assertRaisesRegex(ValueError, "landscape Letter"):
            validate_pdf(self.pdf, 2, "letter")
        reader = PdfReader(self.pdf)
        for index, page in enumerate(reader.pages):
            runs = []
            page.extract_text(visitor_text=lambda text, cm, tm, font, size: runs.append((text, tm)) if text.strip() else None)
            self.assertEqual([round(tm[5], 2) for _, tm in runs], [561.2, 554.2])
            self.assertIn(["FRONT", "BACK"][index], runs[-1][0])

    def test_crowned_portrait_restores_geometry_without_reencoding_and_keeps_margin_labels(self):
        writer = PdfWriter(clone_from=self.pdf)
        for page in writer.pages:
            page.mediabox = RectangleObject([0, 0, 841.68, 595.2])
            image = page["/Resources"]["/XObject"]["/Artwork"]
            image[NameObject("/Width")] = NumberObject(7014)
            image[NameObject("/Height")] = NumberObject(4960)
        with self.pdf.open("wb") as stream:
            writer.write(stream)
        validate_pdf(self.pdf, 2, "crowned-a4", upstream=True)
        self.identity["batchName"] = "W" * 96
        self.labels[0]["label"] = "X" * 96
        identify_pages(self.pdf, self.identity, self.labels, "crowned-a4", refeed_front=True)
        validate_pdf(self.pdf, 2, "crowned-a4")
        with self.assertRaisesRegex(ValueError, "landscape A4"):
            validate_pdf(self.pdf, 2, "a4")
        reader = PdfReader(self.pdf)
        for index, page in enumerate(reader.pages):
            self.assertEqual(page["/Resources"]["/XObject"]["/Artwork"].get_data(), b"\x11\x22\x33")
            transforms = [operands for operands, operator in page.get_contents().operations if operator == b"cm"]
            self.assertEqual([round(float(value), 2) for value in transforms[0]], [0, -1, 1, 0, 0, 841.68])
            runs = []
            page.extract_text(visitor_text=lambda text, cm, tm, font, size: runs.append((text, tm, size)) if text.strip() else None)
            self.assertEqual([round(tm[5], 2) for _, tm, _ in runs], [823.68, 814.68, 805.68])
            self.assertIn(["FRONT", "BACK"][index], runs[-1][0])
            for text, tm, size in runs:
                self.assertLess(tm[4] + len(text.rstrip("\n")) * size * 0.6, 595.2 - 66)
            self.assertEqual("REFEED FOR BACK" in runs[-1][0], index == 0)

    def test_crowned_landscape_retains_the_standard_a4_box_and_upright_art(self):
        writer = PdfWriter(clone_from=self.pdf)
        for page in writer.pages:
            page.mediabox = RectangleObject([0, 0, 841.68, 595.2])
            image = page["/Resources"]["/XObject"]["/Artwork"]
            image[NameObject("/Width")] = NumberObject(7014)
            image[NameObject("/Height")] = NumberObject(4960)
        with self.pdf.open("wb") as stream:
            writer.write(stream)
        validate_pdf(self.pdf, 2, CROWNED_LANDSCAPE, upstream=True)
        self.identity["batchName"] = "W" * 96
        identify_pages(self.pdf, self.identity, self.labels, CROWNED_LANDSCAPE, refeed_front=True)
        validate_pdf(self.pdf, 2, CROWNED_LANDSCAPE)
        reader = PdfReader(self.pdf)
        for index, page in enumerate(reader.pages):
            self.assertEqual(list(page.mediabox), [0, 0, 841.68, 595.2])
            self.assertEqual(page.rotation, 0)
            self.assertEqual(page["/Resources"]["/XObject"]["/Artwork"].get_data(), b"\x11\x22\x33")
            transforms = [values for values, operator in page.get_contents().operations if operator == b"cm"]
            self.assertEqual(transforms, [[10, 0, 0, 10, 100, 100]])
            text = page.extract_text()
            self.assertEqual("REFEED FOR BACK" in text, index == 0)

    def test_rejects_unsafe_or_unbounded_identification_before_replacing_source(self):
        original = self.pdf.read_bytes()
        for identity in ({**self.identity, "requesterName": "name\nnext"}, {**self.identity, "batchName": "🐉"},
                         {**self.identity, "batchName": "x" * 97}, {**self.identity, "version": 2}):
            with self.assertRaises(ValueError):
                identify_pages(self.pdf, identity, self.labels)
            self.assertEqual(self.pdf.read_bytes(), original)

    def test_rejects_missing_or_misnumbered_side_labels(self):
        for labels in (self.labels[:1], [{**self.labels[0], "page": 2}, self.labels[1]],
                       [self.labels[0], {**self.labels[1], "phase": "other"}]):
            with self.assertRaises(ValueError):
                identify_pages(self.pdf, self.identity, labels)

    def test_does_not_tag_an_already_identified_artifact_again(self):
        identify_pages(self.pdf, self.identity, self.labels)
        original = self.pdf.read_bytes()
        with self.assertRaises(ValueError):
            identify_pages(self.pdf, self.identity, self.labels)
        self.assertEqual(self.pdf.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
