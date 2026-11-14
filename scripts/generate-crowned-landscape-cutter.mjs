import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const geometry = JSON.parse(readFileSync(new URL('../server/lib/crownedLandscapeGeometry.json', import.meta.url), 'utf8'));
const outputDirectory = new URL('../public/print-templates/', import.meta.url);
const output = new URL('crowned-a4-landscape-v2.dxf', outputDirectory);
const { cardPixels, paperMillimeters, cornerRadiusMillimeters } = geometry;
const mm = pixels => pixels * 25.4 / cardPixels.ppi;

const records = [];
let handle = 0x100;
function write(...pairs) {
  for (const [code, value] of pairs) {
    records.push(code, typeof value === 'number' ? Number(value.toFixed(6)) : value);
  }
}

function entity(type, ...pairs) {
  write([0, type], [5, (handle++).toString(16).toUpperCase()], [100, 'AcDbEntity'], [8, '0'], ...pairs);
}

function roundedRectangle(x, top, width, height, radius) {
  // DXF measures Y from the bottom of the physical A4 landscape page.
  const y = paperMillimeters.height - top - height;
  const centers = [
    [x + width - radius, y + radius],
    [x + width - radius, y + height - radius],
    [x + radius, y + height - radius],
    [x + radius, y + radius],
  ];
  // R13 closed polylines avoid the modern bulge encoding in Studio's DXF importer.
  // Eight straight segments per corner deviate by less than 0.015 mm at a 3 mm radius.
  const segments = 8;
  entity('POLYLINE', [100, 'AcDb2dPolyline'], [66, 1], [10, 0], [20, 0], [30, 0], [70, 1]);
  for (const [corner, [cx, cy]] of centers.entries()) {
    for (let point = 0; point <= segments; point++) {
      const angle = (corner - 1 + point / segments) * Math.PI / 2;
      entity('VERTEX', [100, 'AcDbVertex'], [100, 'AcDb2dVertex'],
        [10, cx + radius * Math.cos(angle)], [20, cy + radius * Math.sin(angle)], [30, 0]);
    }
  }
  entity('SEQEND');
}

write([0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1012'],
  [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES']);
for (const y of cardPixels.y) {
  for (const x of cardPixels.x) {
    roundedRectangle(mm(x), mm(y), mm(cardPixels.width), mm(cardPixels.height), cornerRadiusMillimeters);
  }
}
write([0, 'ENDSEC'], [0, 'EOF']);
const contents = records.join('\n') + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== contents) throw new Error('The Crowned A4 cutter file is out of sync with the PDF geometry');
} else {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(output, contents);
}
