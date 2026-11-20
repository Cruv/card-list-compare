"""Margin-label regressions; run with the same pypdf/Pillow runtime as the worker."""
import hashlib
import json
import math
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject, RectangleObject
from PIL import Image, ImageDraw

from printGeneratorWorker import CROWNED_LANDSCAPE, DAHLE_A4_PUNCH, POINTS_PER_MM, chunk, dahle_face, identify_pages, merge, proof, validate_pdf


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

    def render(self, name, cards, *, double_faced=False, mixed=False, alignment_marks=None, cut_guides=None):
        directory = self.directory / name
        directory.mkdir()
        packing = {"sheetPacking": "double-faced-first"} if mixed else {}
        alignment = {} if alignment_marks is None else {"dahleAlignmentMarks": alignment_marks}
        guides = {} if cut_guides is None else {"dahleCutGuides": cut_guides}
        chunk({"directory": str(directory), **self.paper, **packing, **alignment, **guides, "cards": cards, "doubleFaced": double_faced,
               "registrationMarks": True,
               "printedIdentification": {"version": 1, "requesterName": "Fixture", "batchName": "Dahle test"},
               "pageLabels": [{"page": 1, "phase": "fronts", "label": "CLC full or partial"}] +
               ([{"page": 2, "phase": "backs", "label": "CLC full or partial"}] if double_faced else [])})
        result = json.loads((directory / "result.json").read_text())
        self.assertFalse(result["registrationMarks"])
        if alignment_marks:
            self.assertIs(result["dahleAlignmentMarks"], True)
        else:
            self.assertNotIn("dahleAlignmentMarks", result)
        if cut_guides:
            self.assertIs(result["dahleCutGuides"], True)
        else:
            self.assertNotIn("dahleCutGuides", result)
        return directory / "sheet.pdf"

    @staticmethod
    def mm_operators(page, operator):
        return [tuple(round(float(value) / POINTS_PER_MM, 4) for value in operands)
                for operands, name in page.get_contents().operations if name == operator]

    def check_media_and_labels(self, page):
        self.assertEqual(page.rotation, 0)
        self.assertAlmostEqual(float(page.mediabox.width) / POINTS_PER_MM, 210, places=5)
        self.assertAlmostEqual(float(page.mediabox.height) / POINTS_PER_MM, 297, places=5)
        label_positions = []
        page.extract_text(visitor_text=lambda text, cm, tm, font, size:
                          label_positions.append((tm, size)) if text.strip() else None)
        self.assertEqual(len(label_positions), 3)
        for position, size in label_positions:
            self.assertGreater((position[5] - size * 0.3) / POINTS_PER_MM, 283.5)

    def check_media_and_ticks(self, page, *, alignment_marks=False):
        self.check_media_and_labels(page)
        y_positions = [283.5, 193.5, 103.5, 13.5]
        ticks = slice(0, 8) if alignment_marks else slice(None)
        self.assertEqual(self.mm_operators(page, b"m")[ticks], [(x, y) for y in y_positions for x in (4.5, 203)])
        self.assertEqual(self.mm_operators(page, b"l")[ticks], [(x, y) for y in y_positions for x in (7, 205.5)])
        self.assertEqual(sum(operator == b"S" for _, operator in page.get_contents().operations), 10 if alignment_marks else 8)

    def check_alignment_guides(self, page, occupied_boundaries, *, proof_sheet=False):
        guide_starts, guide_ends = [], []
        for bottom, boundaries in zip((193.5, 103.5, 13.5), occupied_boundaries):
            for x in boundaries:
                guide_starts.extend(((x, bottom + 6), (x, bottom + 81)))
                guide_ends.extend(((x, bottom + 9), (x, bottom + 84)))
        guides = slice(8, -3) if proof_sheet else slice(8, None)
        self.assertEqual(self.mm_operators(page, b"m")[guides], guide_starts * 2)
        self.assertEqual(self.mm_operators(page, b"l")[guides], guide_ends * 2)
        self.assertEqual(self.mm_operators(page, b"w")[1:3], [(0.4,), (0.18,)])
        self.assertEqual([tuple(values) for values, operator in page.get_contents().operations if operator == b"G"][:3],
                         [(0,), (1,), (0,)])
        # Each stroke is centered on a bleed boundary with 1 mm to a finished edge.
        self.assertGreater(1 - self.mm_operators(page, b"w")[1][0] / 2, 0.75)

    def check_cut_guides(self, page, occupied_cells, *, proof_sheet=False):
        count = 4 * len(occupied_cells)
        starts = self.mm_operators(page, b"m")[: -3 if proof_sheet else None]
        ends = self.mm_operators(page, b"l")[: -3 if proof_sheet else None]
        curves = self.mm_operators(page, b"c")
        half = count + 4
        self.assertEqual(len(starts), 2 * half)
        self.assertEqual(len(curves), 2 * count)
        self.assertEqual(starts[:half], starts[half:])
        self.assertEqual(curves[:count], curves[count:])
        rows = (283.5, 193.5, 103.5, 13.5)
        self.assertEqual(starts[:4], [(4.5, y) for y in rows])
        self.assertEqual(ends, [(205.5, y) for y in rows] * 2)
        widths = self.mm_operators(page, b"w")[:2]
        self.assertEqual(widths, [(0.30,), (0.16,)])
        self.assertGreater(1 - widths[0][0] / 2, 0.75)
        self.assertEqual([tuple(values) for values, op in page.get_contents().operations if op == b"G"][:2], [(1,), (0,)])
        self.assertEqual(sum(op == b"S" for _, op in page.get_contents().operations), 5 if proof_sheet else 2)
        corners = [(x, y, horizontal, vertical) for left, bottom in occupied_cells
                   for x, horizontal in ((left + 4, -1), (left + 61, 1))
                   for y, vertical in ((bottom + 4, -1), (bottom + 86, 1))]
        for (x, y, horizontal, vertical), start, curve in zip(corners, starts[4:half], curves):
            vectors = [((px - x) * horizontal, (py - y) * vertical)
                       for px, py in (start, curve[:2], curve[2:4], curve[4:])]
            self.assertAlmostEqual(math.degrees(math.atan2(vectors[0][1], vectors[0][0])), 30, places=2)
            self.assertAlmostEqual(math.degrees(math.atan2(vectors[-1][1], vectors[-1][0])), 60, places=2)
            for index in range(21):
                t = index / 20
                weights = ((1-t)**3, 3*t*(1-t)**2, 3*t*t*(1-t), t**3)
                dx, dy = (sum(weight * vector[axis] for weight, vector in zip(weights, vectors)) for axis in range(2))
                radius = math.hypot(dx, dy)
                self.assertAlmostEqual(radius, 4.05, places=3)
                self.assertGreater(radius - 0.15 - 3, 0.75)  # Combined displacement toward the ink.
                self.assertLess((radius + 0.15) * max(dx, dy) / radius, 4 - 0.15)  # Clear of the strip lines.
                if t == 0.5:
                    self.assertGreater(4 - (radius + 0.15) * dy / radius, 1)

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

    def test_merge_keeps_order_and_exact_stream_bytes_without_publishing_an_invalid_output(self):
        mixed = self.render("ordered", self.cards[:2], double_faced=True)
        ordinary = self.render("another", [{key: value for key, value in self.cards[-1].items() if not key.startswith("back")}])
        output = self.directory / "packets.pdf"
        request = {"inputs": [str(mixed), str(ordinary)], "output": str(output), "pageCount": 3, **self.paper}
        merge(request)
        with PdfReader(mixed) as first, PdfReader(ordinary) as second, PdfReader(output) as merged:
            self.assertEqual(merged.metadata.title, "CLC A4 3x3 - Dahle 550 + 63x88 R3 Punch")
            for source, target in zip([*first.pages, *second.pages], merged.pages):
                self.assertEqual(source.extract_text(), target.extract_text())
                for name, image in source["/Resources"]["/XObject"].items():
                    target_image = target["/Resources"]["/XObject"][name]
                    self.assertEqual(image.get_object()["/Filter"], target_image["/Filter"])
                    self.assertEqual(image.get_object()._data, target_image._data)
        original = output.read_bytes()
        with self.assertRaisesRegex(ValueError, "Expected 2 pages, got 3"):
            merge({**request, "pageCount": 2})
        self.assertEqual(output.read_bytes(), original)
        self.assertEqual(list(self.directory.glob(".merge-*")), [])

    def test_one_sheet_proof_uses_exact_dahle_grid_ticks_and_metric_scale(self):
        name = "household-dahle-a4-punch-v1"
        revision = "0123456789ab/01234567"
        proof({**self.paper, "directory": str(self.directory), "registrationMarks": True,
               "proofRecipe": name, "proofRevision": revision})
        with PdfReader(self.directory / "sheet.pdf", strict=True) as reader:
            self.assertEqual(len(reader.pages), 1)
            page = reader.pages[0]
            self.assertEqual(len(page.images), 9)
            boxes = self.mm_operators(page, b"re")
            self.assertEqual(boxes, [(x, y, 65, 90) for y in (193.5, 103.5, 13.5) for x in (7.5, 72.5, 137.5)])
            positions = self.mm_operators(page, b"m")
            self.assertEqual(positions[:8], [(x, y) for y in (283.5, 193.5, 103.5, 13.5) for x in (4.5, 203)])
            scale_start = next(x for x, y in positions if y == 6)
            scale_end = next(x for x, y in self.mm_operators(page, b"l") if y == 6)
            self.assertAlmostEqual(scale_end - scale_start, 50, places=4)
            text = page.extract_text()
            self.assertIn(f"{name} | {revision}", text)
            self.assertIn("Dahle row ticks | FRONT", text)
            self.assertIn("50 mm", text)

    def test_alignment_proof_uses_the_same_full_grid_guides_and_reports_enabled(self):
        proof({**self.paper, "directory": str(self.directory), "registrationMarks": True, "dahleAlignmentMarks": True,
               "proofRecipe": "household-dahle-a4-punch-v1", "proofRevision": "fixture"})
        self.assertIs(json.loads((self.directory / "result.json").read_text())["dahleAlignmentMarks"], True)
        with PdfReader(self.directory / "sheet.pdf", strict=True) as reader:
            self.assertEqual(len(reader.pages), 1)
            page = reader.pages[0]
            self.check_alignment_guides(page, [(7.5, 72.5, 137.5, 202.5)] * 3, proof_sheet=True)
            self.assertIn("Dahle row ticks + die-cutter alignment marks | FRONT", page.extract_text())

    def test_cut_guide_proof_uses_strip_lines_all_corners_and_distinct_page_label(self):
        proof({**self.paper, "directory": str(self.directory), "registrationMarks": True, "dahleCutGuides": True,
               "proofRecipe": "household-dahle-a4-punch-v1", "proofRevision": "fixture"})
        result = json.loads((self.directory / "result.json").read_text())
        self.assertIs(result["dahleCutGuides"], True)
        self.assertNotIn("dahleAlignmentMarks", result)
        self.assertFalse(result["registrationMarks"])
        cells = [(x, y) for y in (193.5, 103.5, 13.5) for x in (7.5, 72.5, 137.5)]
        with PdfReader(self.directory / "sheet.pdf", strict=True) as reader:
            self.assertEqual(len(reader.pages), 1)
            page = reader.pages[0]
            self.check_cut_guides(page, cells, proof_sheet=True)
            self.assertIn("Dahle strip cut lines + R3 corner guides | FRONT", page.extract_text())
            self.assertIn("50 mm", page.extract_text())

    def test_cut_guides_keep_strip_lines_and_mark_only_occupied_corners_on_both_faces(self):
        cards = [{key: value for key, value in card.items() if index >= 5 or not key.startswith("back")}
                 for index, card in enumerate(self.cards[:7])]
        options = {"double_faced": True, "mixed": True}
        unchecked = self.render("no-guide-option", cards, **options)
        disabled = self.render("cut-guide-off", cards, **options, cut_guides=False)
        self.assertEqual(unchecked.read_bytes(), disabled.read_bytes())
        marked = self.render("cut-guide-on", cards, **options, cut_guides=True)
        with PdfReader(marked) as reader, PdfReader(unchecked) as baseline:
            first, back = reader.pages
            front_cells = [(x, y) for y in (193.5, 103.5) for x in (7.5, 72.5, 137.5)] + [(7.5, 13.5)]
            self.check_cut_guides(first, front_cells)
            self.check_cut_guides(back, [(7.5, 103.5), (137.5, 13.5)])
            for page, original in zip(reader.pages, baseline.pages):
                self.check_media_and_labels(page)
                for operator in (b"re", b"cm"):
                    self.assertEqual(self.mm_operators(page, operator), self.mm_operators(original, operator))
                self.assertEqual([image.data for image in page.images], [image.data for image in original.images])
                self.assertEqual(page.extract_text(), original.extract_text())

    def test_alignment_guides_track_actual_front_and_mirrored_back_occupancy(self):
        cards = [{key: value for key, value in card.items() if index >= 5 or not key.startswith("back")}
                 for index, card in enumerate(self.cards[:7])]
        options = {"double_faced": True, "mixed": True}
        omitted = self.render("mixed-omitted", cards, **options)
        explicit_off = self.render("mixed-off", cards, **options, alignment_marks=False)
        self.assertEqual(omitted.read_bytes(), explicit_off.read_bytes())
        self.assertEqual((omitted.parent / "result.json").read_bytes(), (explicit_off.parent / "result.json").read_bytes())
        marked = self.render("mixed-on", cards, **options, alignment_marks=True)
        with PdfReader(marked) as reader, PdfReader(omitted) as baseline:
            front, back = reader.pages
            self.check_alignment_guides(front, [(7.5, 72.5, 137.5, 202.5)] * 2 + [(7.5, 72.5)])
            self.check_alignment_guides(back, [(), (7.5, 72.5), (137.5, 202.5)])
            for page, original in zip(reader.pages, baseline.pages):
                self.check_media_and_ticks(page, alignment_marks=True)
                self.check_media_and_ticks(original)
                for operator in (b"re", b"cm"):
                    self.assertEqual(self.mm_operators(page, operator), self.mm_operators(original, operator))
                self.assertEqual([image.data for image in page.images], [image.data for image in original.images])
                self.assertEqual(page.extract_text(), original.extract_text())

    def test_rejects_nonboolean_or_cross_preset_alignment_marks(self):
        for request in ({**self.paper, "dahleAlignmentMarks": "true"}, {"paperSize": "letter", "dahleAlignmentMarks": True}):
            with self.subTest(request=request), self.assertRaisesRegex(ValueError, "Dahle-only"):
                chunk({"directory": str(self.directory), **request})

    def test_rejects_bad_cut_guide_and_combined_settings(self):
        requests = (({**self.paper, "dahleCutGuides": 1}, "Dahle-only"),
                    ({"paperSize": "letter", "dahleCutGuides": True}, "Dahle-only"),
                    ({**self.paper, "dahleCutGuides": True, "dahleAlignmentMarks": True}, "Choose either"))
        for request, error in requests:
            with self.subTest(request=request), self.assertRaisesRegex(ValueError, error):
                chunk({"directory": str(self.directory), **request})

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
