"""Margin-label regressions; run with the same pypdf/Pillow runtime as the worker."""
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject, RectangleObject
from PIL import Image, ImageDraw

from printGeneratorWorker import (CROWNED_LANDSCAPE, DAHLE_A4_PUNCH, DAHLE_LETTER_PUNCH, POINTS_PER_MM,
                                  chunk, dahle_face, identify_pages, merge, mirror_artwork_edges, proof,
                                  repair_scan_fringe, validate_pdf)


class DahlePunchTests(unittest.TestCase):
    bleed = 1.5
    cell_width, cell_height = 66, 91
    cell_lefts = (6, 72, 138)
    cell_bottoms = (194, 103, 12)
    row_cuts = (285, 194, 103, 12)
    letter_paper = {"paperSize": "letter", "printPreset": DAHLE_LETTER_PUNCH}
    letter_row_cuts = (276.2, 185.2, 94.2, 3.2)
    letter_cells = [(x, y) for y in (185.2, 94.2, 3.2) for x in (8.95, 74.95, 140.95)]

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

    def render(self, name, cards, *, double_faced=False, mixed=False, alignment_marks=None, cut_guides=None, paper=None,
               requester="Fixture", batch="Dahle test", page_label="CLC full or partial", generated_date=None):
        directory = self.directory / name
        directory.mkdir()
        packing = {"sheetPacking": "double-faced-first"} if mixed else {}
        alignment = {} if alignment_marks is None else {"dahleAlignmentMarks": alignment_marks}
        guides = {} if cut_guides is None else {"dahleCutGuides": cut_guides}
        identification = {"version": 1, "requesterName": requester, "batchName": batch}
        if generated_date is not None:
            identification["generatedDate"] = generated_date
        chunk({"directory": str(directory), **(paper or self.paper), **packing, **alignment, **guides,
               "cards": cards, "doubleFaced": double_faced,
               "registrationMarks": True,
               "printedIdentification": identification,
               "pageLabels": [{"page": 1, "phase": "fronts", "label": page_label}] +
               ([{"page": 2, "phase": "backs", "label": page_label}] if double_faced else [])})
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

    def check_media_and_labels(self, page, *, proof_sheet=False):
        self.assertEqual(page.rotation, 0)
        self.assertAlmostEqual(float(page.mediabox.width) / POINTS_PER_MM, 210, places=5)
        self.assertAlmostEqual(float(page.mediabox.height) / POINTS_PER_MM, 297, places=5)
        label_positions = []
        page.extract_text(visitor_text=lambda text, cm, tm, font, size:
                          label_positions.append((tm, size)) if text.strip() else None)
        self.assertEqual(len(label_positions), 4 if proof_sheet else 3)
        for position, size in label_positions[:3]:
            self.assertGreater((position[5] - size * 0.3) / POINTS_PER_MM, self.row_cuts[0] + 0.22)
        if proof_sheet:
            position, size = label_positions[-1]
            self.assertLess((position[5] + size * 0.8) / POINTS_PER_MM, self.row_cuts[-1] - 0.22)

    def check_media_and_ticks(self, page, *, alignment_marks=False):
        self.check_media_and_labels(page)
        ticks = slice(0, 8) if alignment_marks else slice(None)
        self.assertEqual(self.mm_operators(page, b"m")[ticks], [(x, y) for y in self.row_cuts for x in (4.5, 204.2)])
        self.assertEqual(self.mm_operators(page, b"l")[ticks], [(x, y) for y in self.row_cuts for x in (5.8, 205.5)])
        self.assertEqual(sum(operator == b"S" for _, operator in page.get_contents().operations), 10 if alignment_marks else 8)

    def check_alignment_guides(self, page, occupied_boundaries, *, proof_sheet=False):
        guide_starts, guide_ends = [], []
        for bottom, boundaries in zip(self.cell_bottoms, occupied_boundaries):
            for x in boundaries:
                guide_starts.extend(((x, bottom + 6), (x, bottom + 82)))
                guide_ends.extend(((x, bottom + 9), (x, bottom + 85)))
        guides = slice(8, -3) if proof_sheet else slice(8, None)
        self.assertEqual(self.mm_operators(page, b"m")[guides], guide_starts * 2)
        self.assertEqual(self.mm_operators(page, b"l")[guides], guide_ends * 2)
        self.assertEqual(self.mm_operators(page, b"w")[1:3], [(0.4,), (0.18,)])
        self.assertEqual([tuple(values) for values, operator in page.get_contents().operations if operator == b"G"][:3],
                         [(0,), (1,), (0,)])
        # The stroke is centered in the 3 mm gutter between finished cards.
        self.assertGreater(self.bleed - self.mm_operators(page, b"w")[1][0] / 2, 1.25)

    def check_cut_guides(self, page, occupied_cells, *, proof_sheet=False):
        count = 4 * len(occupied_cells)
        starts = self.mm_operators(page, b"m")[: -3 if proof_sheet else None]
        ends = self.mm_operators(page, b"l")[: -3 if proof_sheet else None]
        curves = self.mm_operators(page, b"c")
        rows = self.row_cuts
        strip_starts, strip_ends = ([(x, y) for y in rows] for x in (3.2, 206.8))
        line_starts = strip_starts * 2
        self.assertEqual(starts[:len(line_starts)], line_starts)
        self.assertEqual(ends, strip_ends * 2)
        arc_starts = starts[len(line_starts):]
        self.assertEqual(len(arc_starts), 2 * count)
        self.assertEqual(len(curves), 2 * count)
        self.assertEqual(arc_starts[:count], arc_starts[count:])
        self.assertEqual(curves[:count], curves[count:])
        operations = page.get_contents().operations
        stroke_colors = [(op, tuple(map(float, values))) for values, op in operations if op in (b"G", b"RG")]
        gray = (b"G", (0,))
        lime = (b"RG", (0.58, 1, 0.06))
        widths = [(0.44,), (0.28,)]
        colors = [gray, lime]
        if occupied_cells:
            widths.extend([(0.52,), (0.40,)])
            colors.extend([gray, lime])
        self.assertEqual(self.mm_operators(page, b"w")[:len(widths)], widths)
        self.assertEqual([tuple(values) for values, op in operations if op == b"J"], [(0,)] * (len(widths) // 2))
        self.assertEqual(stroke_colors[:len(colors)], colors)
        self.assertEqual(sum(op == b"S" for _, op in operations), len(widths) + (3 if proof_sheet else 0))
        strip_half_width = widths[0][0] / 2
        self.assertAlmostEqual(self.bleed - strip_half_width, 1.28)
        if not occupied_cells:
            self.assertEqual(stroke_colors, colors)  # The back has no lime corner arcs.
            return

        arc_half_width = widths[2][0] / 2
        lime_half_width = widths[3][0] / 2
        corner_inset = self.bleed + 3
        corners = [(x, y, horizontal, vertical) for left, bottom in occupied_cells
                   for x, horizontal in ((left + corner_inset, -1), (left + self.cell_width - corner_inset, 1))
                   for y, vertical in ((bottom + corner_inset, -1), (bottom + self.cell_height - corner_inset, 1))]
        lime_points = []
        for arc_index, ((x, y, horizontal, vertical), start, curve) in enumerate(zip(corners, arc_starts, curves)):
            vectors = [((px - x) * horizontal, (py - y) * vertical)
                       for px, py in (start, curve[:2], curve[2:4], curve[4:])]
            self.assertAlmostEqual(math.degrees(math.atan2(vectors[0][1], vectors[0][0])), 20, places=2)
            self.assertAlmostEqual(math.degrees(math.atan2(vectors[-1][1], vectors[-1][0])), 70, places=2)
            for index in range(21):
                t = index / 20
                weights = ((1-t)**3, 3*t*(1-t)**2, 3*t*t*(1-t), t**3)
                dx, dy = (sum(weight * vector[axis] for weight, vector in zip(weights, vectors)) for axis in range(2))
                radius = math.hypot(dx, dy)
                self.assertAlmostEqual(radius - arc_half_width - 3, 0.10, places=3)
                self.assertAlmostEqual(radius - lime_half_width - 3, 0.16, places=3)
                self.assertLess((radius + arc_half_width) * max(dx, dy) / radius, corner_inset - strip_half_width)
                # Test just inside the lime stroke, away from the antialiased edge.
                lime_scale = (radius - lime_half_width + 0.03) / radius
                self.assertGreater(corner_inset - dy * lime_scale, 1.25)  # Both ends survive the modeled strip trim.
                if arc_index < 4:
                    lime_points.append((horizontal * (28.5 + dx * lime_scale), vertical * (41 + dy * lime_scale)))
        self.check_punch_window(lime_points)

    def check_punch_window(self, lime_points):
        def distance(x, y):
            # Rounded 63 × 88 mm window centered at the origin, R3 at each corner.
            x, y = abs(x) - 28.5, abs(y) - 41
            return math.hypot(max(x, 0), max(y, 0)) + min(max(x, y), 0) - 3

        self.assertGreater(min(distance(x, y) for x, y in lime_points), 0)
        for degrees in range(0, 360, 5):
            angle = math.radians(degrees)
            dx, dy = 0.35 * math.cos(angle), 0.35 * math.sin(angle)
            self.assertLess(min(distance(x - dx, y - dy) for x, y in lime_points), -0.1)
        for degrees in (-0.75, 0.75):
            angle = math.radians(degrees)
            cos, sin = math.cos(angle), math.sin(angle)
            self.assertLess(min(distance(x * cos + y * sin, -x * sin + y * cos) for x, y in lime_points), 0)

    def check_image(self, page, slot, color):
        image = page.images[f"/Card{slot + 1}"].image
        for point, expected in (((160, 220), color), ((160, 40), (255, 255, 255))):
            self.assertTrue(all(abs(channel - goal) <= 3 for channel, goal in zip(image.getpixel(point), expected)))

    def check_letter_margin_labels(self, page, *, proof_sheet=False, cut_guides=False):
        self.assertEqual(page.rotation, 0)
        self.assertAlmostEqual(float(page.mediabox.width), 612)
        self.assertAlmostEqual(float(page.mediabox.height), 792)
        labels = []
        page.extract_text(visitor_text=lambda text, cm, tm, font, size:
                          labels.append((text.rstrip(), tm, size)) if text.strip() else None)
        left_count = 3 if cut_guides else 2
        self.assertEqual(len(labels), left_count + int(proof_sheet))
        column_edges = [(3, 8.95)] * left_count
        if proof_sheet:
            column_edges.append((206.95, 212.9))
        for (text, position, size), (left, right) in zip(labels, column_edges):
            self.assertEqual(position[:4], [0, 1, -1, 0])
            # Courier's ascent projects to the left after the quarter turn.
            self.assertGreater((position[4] - size * 0.8) / POINTS_PER_MM, left)
            self.assertLess((position[4] + size * 0.3) / POINTS_PER_MM, right)
        if cut_guides:
            scales = [float(values[0]) / 100 for values, op in page.get_contents().operations if op == b"Tz"]
            self.assertEqual(len(scales), 3)
            for index, ((text, position, size), scale) in enumerate(zip(labels[:3], scales)):
                self.assertEqual(size, 6.8)
                self.assertGreater(scale, 0.5)
                self.assertLessEqual(scale, 1)
                start = position[5] / POINTS_PER_MM
                end = start + size * 0.6 * len(text) * scale / POINTS_PER_MM
                self.assertGreater(start, self.letter_row_cuts[index + 1] + 2.99)
                self.assertLess(end, self.letter_row_cuts[index] - 2.99)
        else:
            for text, position, size in labels[:left_count]:
                self.assertGreater(position[5] / POINTS_PER_MM, 3)
                self.assertLess((position[5] + size * 0.6 * len(text)) / POINTS_PER_MM, 276.4)

    def test_printed_paper_and_date_fit_a4_and_letter_on_both_faces(self):
        requester, batch, label = "R" * 48, "B" * 96, "S" * 96
        for paper, cut_guides, stock in ((self.paper, True, "A4"),
                                         (self.letter_paper, True, "US Letter"),
                                         (self.letter_paper, False, "US Letter")):
            with self.subTest(paper=stock, cut_guides=cut_guides):
                sheet = self.render(f"{stock}-{cut_guides}", self.cards[:1], paper=paper, cut_guides=cut_guides,
                                    double_faced=True, requester=requester, batch=batch, page_label=label,
                                    generated_date="2026-11-20")
                with PdfReader(sheet) as reader:
                    for page, phase in zip(reader.pages, ("FRONT", "BACK")):
                        if stock == "A4":
                            self.check_media_and_labels(page)
                        else:
                            self.check_letter_margin_labels(page, cut_guides=cut_guides)
                        text = page.extract_text()
                        self.assertIn(f"{stock} | Generated 2026-11-20", text)
                        self.assertIn(f"Prepared by: {requester}", text)
                        self.assertIn(f"Batch: {batch}", text)
                        self.assertIn(f"{label} | {phase}", text)

    def test_exact_a4_and_fixed_full_and_partial_page_geometry(self):
        fronts = [{key: value for key, value in card.items() if not key.startswith("back")} for card in self.cards]
        full = self.render("full", fronts)
        partial = self.render("partial", fronts[:4])
        output = self.directory / "fronts.pdf"
        merge({"inputs": [str(full), str(partial)], "output": str(output), "pageCount": 2, **self.paper})
        with PdfReader(output) as reader:
            for index, page in enumerate(reader.pages):
                self.check_media_and_ticks(page)
                positions = [(x, y, self.cell_width, self.cell_height) for y in self.cell_bottoms for x in self.cell_lefts]
                occupied = 9 if index == 0 else 4
                self.assertEqual(self.mm_operators(page, b"re"), positions[:occupied])
                self.assertEqual(sum(operator == b"W" for _, operator in page.get_contents().operations), occupied)
                transforms = self.mm_operators(page, b"cm")
                # Fixture pixels are 0.2 mm wide. Mirror 1.6 mm, center the original trim, and clip at 1.5 mm.
                self.assertEqual(transforms, [(66.2, 0, 0, 91.2, x - 0.1, y - 0.1) for x, y, _, _ in positions[:occupied]])
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
            self.check_media_and_labels(page, proof_sheet=True)
            self.assertEqual(len(page.images), 9)
            boxes = self.mm_operators(page, b"re")
            self.assertEqual(boxes, [(x, y, self.cell_width, self.cell_height) for y in self.cell_bottoms for x in self.cell_lefts])
            positions = self.mm_operators(page, b"m")
            self.assertEqual(positions[:8], [(x, y) for y in self.row_cuts for x in (4.5, 204.2)])
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
            self.check_alignment_guides(page, [(6, 72, 138, 204)] * 3, proof_sheet=True)
            self.assertIn("Dahle row ticks + die-cutter alignment marks | FRONT", page.extract_text())

    def test_cut_guide_proof_uses_strip_lines_all_corners_and_distinct_page_label(self):
        proof({**self.paper, "directory": str(self.directory), "registrationMarks": True, "dahleCutGuides": True,
               "proofRecipe": "household-dahle-a4-punch-v1", "proofRevision": "fixture"})
        result = json.loads((self.directory / "result.json").read_text())
        self.assertIs(result["dahleCutGuides"], True)
        self.assertNotIn("dahleAlignmentMarks", result)
        self.assertFalse(result["registrationMarks"])
        cells = [(x, y) for y in self.cell_bottoms for x in self.cell_lefts]
        with PdfReader(self.directory / "sheet.pdf", strict=True) as reader:
            self.assertEqual(len(reader.pages), 1)
            page = reader.pages[0]
            self.check_media_and_labels(page, proof_sheet=True)
            self.check_cut_guides(page, cells, proof_sheet=True)
            self.assertIn("Dahle strip cut lines + R3 corner guides | FRONT", page.extract_text())
            self.assertIn("50 mm", page.extract_text())

    def test_cut_guides_keep_strip_lines_on_both_faces_and_mark_only_occupied_front_corners(self):
        cards = [{key: value for key, value in card.items() if index >= 5 or not key.startswith("back")}
                 for index, card in enumerate(self.cards[:7])]
        options = {"double_faced": True, "mixed": True}
        unchecked = self.render("no-guide-option", cards, **options)
        disabled = self.render("cut-guide-off", cards, **options, cut_guides=False)
        self.assertEqual(unchecked.read_bytes(), disabled.read_bytes())
        marked = self.render("cut-guide-on", cards, **options, cut_guides=True)
        with PdfReader(marked) as reader, PdfReader(unchecked) as baseline:
            first, back = reader.pages
            front_cells = [(x, y) for y in self.cell_bottoms[:2] for x in self.cell_lefts] + [(6, 12)]
            self.check_cut_guides(first, front_cells)
            self.check_cut_guides(back, [])
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
            self.check_alignment_guides(front, [(6, 72, 138, 204)] * 2 + [(6, 72)])
            self.check_alignment_guides(back, [(), (6, 72), (138, 204)])
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
            self.assertEqual(self.mm_operators(back, b"re"), [(72, 194, 66, 91), (6, 194, 66, 91),
                                                             (138, 103, 66, 91), (72, 103, 66, 91)])
            self.assertEqual(len(back.images), 4)
            for slot in range(1, 5):
                self.check_image(back, slot, self.back_colors[slot])

    def test_letter_full_and_partial_duplex_keep_upright_exact_trim_and_mirrored_backs(self):
        requester, batch, label = "R" * 48, "B" * 96, "S" * 96
        full = self.render("letter-full", self.cards, cut_guides=True, double_faced=True, paper=self.letter_paper,
                           requester=requester, batch=batch, page_label=label)
        partial = self.render("letter-partial", self.cards[:4], cut_guides=True, double_faced=True, paper=self.letter_paper)
        output = self.directory / "letter.pdf"
        merge({"inputs": [str(full), str(partial)], "output": str(output), "pageCount": 4, **self.letter_paper})
        with PdfReader(output, strict=True) as reader:
            self.assertEqual(reader.metadata.title, "CLC US Letter 3x3 - Dahle 550 + 63x88 R3 Punch")
            guide_paths = {op: self.mm_operators(reader.pages[0], op)[:8] for op in (b"m", b"l")}
            for index, (page, occupied) in enumerate(zip(reader.pages, (9, 9, 4, 4))):
                is_back = index % 2 == 1
                self.check_letter_margin_labels(page, cut_guides=True)
                self.assertIn(f"| {'BACK' if is_back else 'FRONT'}", page.extract_text())
                self.assertNotIn("REFEED FOR BACK", page.extract_text())
                if occupied == 9:
                    self.assertIn(f"Prepared by: {requester}", page.extract_text())
                    self.assertIn(f"Batch: {batch}", page.extract_text())
                    self.assertIn(label, page.extract_text())
                for op, expected in guide_paths.items():
                    self.assertEqual(self.mm_operators(page, op)[:8], expected)
                self.assertEqual(self.mm_operators(page, b"l"), guide_paths[b"l"])
                front = self.letter_cells[:occupied]
                cells = [(215.9 - self.cell_width - x, y) for x, y in front] if is_back else front
                self.assertEqual(self.mm_operators(page, b"re"), [(round(x, 4), y, 66, 91) for x, y in cells])
                self.assertEqual(self.mm_operators(page, b"cm"),
                                 [(66.2, 0, 0, 91.2, round(x - 0.1, 4), round(y - 0.1, 4)) for x, y in cells])
                self.assertEqual(len(page.images), occupied)
                self.assertEqual(len(self.mm_operators(page, b"c")), 0 if is_back else 8 * occupied)
                for slot in range(occupied):
                    self.check_image(page, slot, (self.back_colors if is_back else self.front_colors)[slot])

    def test_letter_proofs_have_exact_cut_references_and_a_vertical_metric_scale(self):
        for guided in (False, True):
            with self.subTest(guided=guided):
                folder = self.directory / str(guided)
                folder.mkdir()
                name = "household-dahle-letter-punch-v1"
                proof({**self.letter_paper, "directory": str(folder), "registrationMarks": True, "dahleCutGuides": guided,
                       "proofRecipe": name, "proofRevision": "fixture"})
                result = json.loads((folder / "result.json").read_text())
                self.assertEqual(result.get("dahleCutGuides", False), guided)
                self.assertFalse(result["registrationMarks"])
                with PdfReader(folder / "sheet.pdf", strict=True) as reader:
                    self.assertEqual(len(reader.pages), 1)
                    page = reader.pages[0]
                    self.check_letter_margin_labels(page, proof_sheet=True, cut_guides=guided)
                    mark_label = "Dahle strip cut lines + R3 corner guides" if guided else "Dahle row ticks"
                    self.assertIn(f"{mark_label} | FRONT", page.extract_text())
                    self.assertIn(f"{name} | fixture", page.extract_text())
                    self.assertIn("50 mm", page.extract_text())
                    self.assertEqual(self.mm_operators(page, b"re"), [(x, y, 66, 91) for x, y in self.letter_cells])
                    self.assertEqual(len(page.images), 9)
                    starts, ends = (self.mm_operators(page, operator) for operator in (b"m", b"l"))
                    self.assertEqual(starts[-3], (210.75, 114.7))
                    self.assertEqual(ends[-3], (210.75, 164.7))
                    if not guided:
                        self.assertEqual(starts[:-3], [(x, y) for y in self.letter_row_cuts for x in (8.95, 205.65)] * 2)
                        self.assertEqual(ends[:-3], [(x, y) for y in self.letter_row_cuts for x in (10.25, 206.95)] * 2)
                        self.assertEqual(self.mm_operators(page, b"w")[:2], [(0.36,), (0.17,)])
                        self.assertEqual([tuple(values) for values, op in page.get_contents().operations if op == b"G"][:2],
                                         [(1,), (0,)])
                        self.assertGreater(self.letter_row_cuts[-1] - 0.36 / 2, 3)
                        self.assertLess(self.letter_row_cuts[0] + 0.36 / 2, 276.4)
                        continue
                    widths = self.mm_operators(page, b"w")
                    self.assertEqual(widths[:-1], [(0.44,), (0.28,), (0.52,), (0.40,)])
                    self.assertEqual([tuple(values) for values, op in page.get_contents().operations if op == b"J"], [(0,)] * 2)
                    line_y = (275.98, 185.2, 94.2, 3.42) * 2
                    self.assertEqual(starts[:8], [(3.2, y) for y in line_y])
                    self.assertEqual(ends[:-3], [(212.7, y) for y in line_y])
                    half_outer_width = widths[0][0] / 2
                    self.assertAlmostEqual(line_y[0] + half_outer_width, self.letter_row_cuts[0])
                    self.assertAlmostEqual(line_y[3] - half_outer_width, self.letter_row_cuts[-1])
                    self.assertGreater(line_y[3] - half_outer_width, 3)
                    self.assertLess(line_y[0] + half_outer_width, 276.4)

    def test_dahle_letter_and_a4_reject_mismatched_paper_sizes(self):
        for paper_size, preset in (("a4", DAHLE_LETTER_PUNCH), ("letter", DAHLE_A4_PUNCH)):
            with self.subTest(paper_size=paper_size), self.assertRaisesRegex(ValueError, "Unsupported paper size"):
                chunk({"directory": str(self.directory), "paperSize": paper_size, "printPreset": preset})

    def test_uses_mpc_source_bleed_independently_of_the_output_clip(self):
        path = self.directory / "mpc.png"
        artwork = Image.new("RGB", (1387, 1887), "magenta")
        ImageDraw.Draw(artwork).rectangle((64, 64, 1323, 1823), fill="navy")
        artwork.save(path)
        for output_bleed in (0, 1, 1.5, 2):
            _, metadata, (width, height) = dahle_face(path, "saved-mpc", output_bleed)
            self.assertEqual(metadata["sourceBleedMm"], 3.175)
            self.assertAlmostEqual(width, 69.35)
            self.assertAlmostEqual(height, 94.35)
        cards = [{"id": "mpc", "frontPath": str(path), "frontSource": "saved-mpc"}]
        with PdfReader(self.render("mpc", cards)) as reader:
            page = reader.pages[0]
            self.assertEqual(self.mm_operators(page, b"re"), [(6, 194, 66, 91)])
            self.assertEqual(self.mm_operators(page, b"cm"), [(69.35, 0, 0, 94.35, 4.325, 192.325)])
            width, _, _, height, x, y = self.mm_operators(page, b"cm")[0]
            self.assertAlmostEqual(width - 2 * 3.175, 63)
            self.assertAlmostEqual(height - 2 * 3.175, 88)
            self.assertAlmostEqual(x + 3.175, 7.5)
            self.assertAlmostEqual(y + 3.175, 195.5)
        Image.new("RGB", (300, 400), "red").save(path)
        with self.assertRaisesRegex(ValueError, "no recognized 63 × 88 mm trim geometry"):
            dahle_face(path, "saved-mpc", 1)

    def test_extends_trim_only_art_including_transparent_rounded_corners(self):
        path = self.directory / "scryfall.png"
        artwork = Image.new("RGBA", (315, 440), (0, 0, 0, 0))
        ImageDraw.Draw(artwork).rounded_rectangle((0, 0, 314, 439), radius=25, fill="navy")
        artwork.save(path)
        for output_bleed, expected in ((0, (63, 88)), (1, (65, 90)), (1.5, (66.2, 91.2)), (2, (67, 92))):
            _, metadata, dimensions = dahle_face(path, "scryfall", output_bleed)
            self.assertEqual(metadata["sourceBleedMm"], 0)
            self.assertEqual(dimensions, expected)
        cards = [{"id": "rounded", "frontPath": str(path), "frontSource": "scryfall"}]
        with PdfReader(self.render("rounded", cards)) as reader:
            image = reader.pages[0].images[0].image
            self.assertTrue(all(abs(channel - goal) <= 3 for channel, goal in zip(image.getpixel((0, 0)), (0, 0, 128))))

    def test_edge_reflection_preserves_small_source_without_repeating_the_outer_pixel(self):
        source = Image.new("RGB", (5, 7), (210, 210, 210))
        ImageDraw.Draw(source).rectangle((0, 0, 4, 6), outline=(20, 20, 20))
        result = mirror_artwork_edges(source, 1)
        self.assertEqual(result.size, (7, 9))
        self.assertEqual(result.crop((1, 1, 6, 8)).tobytes(), source.tobytes())
        for point in ((0, 4), (6, 4), (3, 0), (3, 8), (0, 0), (6, 8)):
            self.assertEqual(result.getpixel(point), (210, 210, 210))

    def test_plain_dahle_pdfs_extend_past_an_opaque_fringe_but_keep_full_dark_borders(self):
        width, height, pad = 315, 440, 8
        for actual_paper in (self.paper, self.letter_paper):
            for border in (1, 20):
                with self.subTest(paper=actual_paper["paperSize"], border=border):
                    path = self.directory / f"opaque-edge-{border}.png"
                    artwork = Image.new("RGBA", (width, height), (210, 210, 210, 255))
                    ImageDraw.Draw(artwork).rectangle((0, 0, width - 1, height - 1), outline=(20, 20, 20, 255), width=border)
                    artwork.save(path)
                    cards = [{"id": "opaque-edge", "frontPath": str(path), "frontSource": "scryfall"}]
                    with PdfReader(self.render(f"{actual_paper['paperSize']}-{border}", cards, paper=actual_paper)) as reader:
                        page = reader.pages[0]
                        self.assertEqual(self.mm_operators(page, b"c"), [])
                        image = page.images[0].image
                        self.assertEqual(image.size, (width + 2 * pad, height + 2 * pad))
                        x, y = width // 2 + pad, height // 2 + pad
                        trim_edge = ((pad, y), (width + pad - 1, y), (x, pad), (x, height + pad - 1))
                        bleed_edge = ((pad - 1, y), (width + pad, y), (x, pad - 1), (x, height + pad))
                        for point in trim_edge:
                            self.assertAlmostEqual(image.getpixel(point)[0], 20, delta=3)
                        for point in bleed_edge:
                            self.assertAlmostEqual(image.getpixel(point)[0], 210 if border == 1 else 20, delta=3)

    def test_scan_fringe_repairs_only_opaque_outer_pixels_that_track_the_adjacent_art(self):
        width, height = 40, 60
        clean = Image.new("RGB", (width, height))
        clean.putdata([(70 + x + y,) * 3 for y in range(height) for x in range(width)])
        fringe = clean.copy()
        for y in range(height):
            for x, inward in ((0, 1), (width - 1, width - 2)):
                fringe.putpixel((x, y), tuple(value // 2 for value in clean.getpixel((inward, y))))
        for x in range(width):
            for y, inward in ((0, 1), (height - 1, height - 2)):
                fringe.putpixel((x, y), tuple(value // 2 for value in clean.getpixel((x, inward))))

        opacity = Image.new("L", clean.size, 255)
        opacity.putpixel((0, 7), 120)
        opacity.putpixel((1, 11), 120)
        expected = clean.copy()
        for y in range(1, height - 1):
            for x, inward in ((0, 1), (width - 1, width - 2)):
                expected.putpixel((x, y), clean.getpixel((inward, y)))
        for x in range(1, width - 1):
            for y, inward in ((0, 1), (height - 1, height - 2)):
                expected.putpixel((x, y), clean.getpixel((x, inward)))
        for point in ((0, 0), (0, height - 1), (width - 1, 0), (width - 1, height - 1), (0, 7), (0, 11)):
            expected.putpixel(point, fringe.getpixel(point))
        repair_scan_fringe(fringe, opacity)
        self.assertEqual(fringe.tobytes(), expected.tobytes())

        for border in (1, 4):
            with self.subTest(intentional_frame_width=border):
                framed = clean.copy()
                ImageDraw.Draw(framed).rectangle((0, 0, width - 1, height - 1), outline=(50, 50, 50), width=border)
                original = framed.tobytes()
                repair_scan_fringe(framed, None)
                self.assertEqual(framed.tobytes(), original)

    def test_scan_fringe_repair_is_limited_to_scryfall_artwork_requiring_synthetic_bleed(self):
        def bordered_source(name, size):
            width, height = size
            image = Image.new("RGB", size, (100, 100, 100))
            draw = ImageDraw.Draw(image)
            draw.rectangle((0, height // 2, width - 1, height - 1), fill=(190, 190, 190))
            draw.line((0, 0, 0, height // 2 - 1), fill=(50, 50, 50))
            draw.line((0, height // 2, 0, height - 1), fill=(95, 95, 95))
            path = self.directory / name
            image.save(path)
            return path

        trim = bordered_source("trim.png", (630, 880))
        small = bordered_source("small.png", (315, 440))
        native = bordered_source("native.png", (694, 944))
        for path, source, output_bleed, pad, sample in (
                (trim, "scryfall", 0, 0, 50),
                (trim, "scryfall", 1.5, 15, 100),
                (small, "scryfall", 1.5, 8, 50),
                (trim, "saved-mpc", 1.5, 15, 50),
                (native, "saved-mpc", 1.5, 0, 50),
                (native, "saved-mpc", 3.2, 1, 50)):
            with self.subTest(source=source, output_bleed=output_bleed):
                face, _, _ = dahle_face(path, source, output_bleed)
                with Image.open(BytesIO(face._data)) as image:
                    self.assertAlmostEqual(image.getpixel((pad, 100 + pad))[0], sample, delta=3)


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
        self.identity.update(requesterName="(person) \\ <test>", batchName="W" * 96, generatedDate="2026-11-20")
        self.labels[0]["label"] = "F" * 96
        identify_pages(self.pdf, self.identity, self.labels)
        reader = PdfReader(self.pdf)
        self.assertIn("Queued by: (person) \\ <test>", reader.pages[0].extract_text())
        for page in reader.pages:
            self.assertIn("US Letter | Generated 2026-11-20", page.extract_text())
            runs = []
            page.extract_text(visitor_text=lambda text, cm, tm, font, size: runs.append((text, tm, size)))
            for text, tm, size in runs:
                if not text.strip():
                    continue
                self.assertLessEqual(size, 7)
                self.assertEqual(tm[4], 66)
                self.assertIn(tm[5], (571, 578))
                self.assertLessEqual(tm[4] + len(text.rstrip("\n")) * size * 0.6, 726)

    def test_invalid_generation_dates_are_rejected_before_changing_the_sheet(self):
        original = self.pdf.read_bytes()
        for invalid in (None, "2026-02-30", "20261120", "2026-11-20 (test)"):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "date must be YYYY-MM-DD"):
                identify_pages(self.pdf, {**self.identity, "generatedDate": invalid}, self.labels)
        self.assertEqual(self.pdf.read_bytes(), original)

    def test_a4_labels_fit_each_side_and_paper_sizes_cannot_be_mixed(self):
        writer = PdfWriter(clone_from=self.pdf)
        for page in writer.pages:
            page.mediabox = RectangleObject([0, 0, 841.68, 595.2])
            image = page["/Resources"]["/XObject"]["/Artwork"]
            image[NameObject("/Width")] = NumberObject(7014)
            image[NameObject("/Height")] = NumberObject(4960)
        with self.pdf.open("wb") as stream:
            writer.write(stream)
        identify_pages(self.pdf, {**self.identity, "generatedDate": "2026-11-20"}, self.labels, "a4")
        validate_pdf(self.pdf, 2, "a4")
        with self.assertRaisesRegex(ValueError, "landscape Letter"):
            validate_pdf(self.pdf, 2, "letter")
        reader = PdfReader(self.pdf)
        for index, page in enumerate(reader.pages):
            runs = []
            page.extract_text(visitor_text=lambda text, cm, tm, font, size: runs.append((text, tm)) if text.strip() else None)
            self.assertEqual([round(tm[5], 2) for _, tm in runs], [561.2, 554.2])
            self.assertIn(["FRONT", "BACK"][index], runs[-1][0])
            self.assertIn("A4 | Generated 2026-11-20", runs[-1][0])

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
        self.identity.update(batchName="W" * 96, generatedDate="2026-11-20")
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
            self.assertIn("A4 | Generated 2026-11-20", runs[0][0])
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
