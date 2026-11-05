"""Margin-label regressions; run with the same pypdf/Pillow runtime as the worker."""
import hashlib
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject

from printGeneratorWorker import identify_pages


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
                self.assertEqual(size, 8)
                self.assertEqual(tm[4], 66)
                self.assertIn(tm[5], (572, 582, 592))
                self.assertLessEqual(tm[4] + len(text.rstrip("\n")) * size * 0.6, 726)

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
