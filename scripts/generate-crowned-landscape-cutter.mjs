import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const geometry = JSON.parse(readFileSync(new URL('../server/lib/crownedLandscapeGeometry.json', import.meta.url), 'utf8'));
const outputDirectory = new URL('../public/print-templates/', import.meta.url);
const output = new URL('crowned-a4-landscape-v1.dxf', outputDirectory);
const { cardPixels, paperMillimeters, cornerRadiusMillimeters } = geometry;
const mm = pixels => pixels * 25.4 / cardPixels.ppi;

// Studio's 10 mm minimum inset is larger than the printed mark's 6 mm
// inset. Place the real sheet 4 mm into this Studio-only page on the mat.
const matOffset = 4;
const studioHeight = paperMillimeters.height + matOffset;
const records = [];
function write(...pairs) {
  for (const [code, value] of pairs) {
    records.push(code, typeof value === 'number' ? Number(value.toFixed(6)) : value);
  }
}

function roundedRectangle(x, top, width, height, radius) {
  const y = studioHeight - top - height;
  const corner = Math.tan(Math.PI / 8);
  const vertices = [
    [x + width - radius, y, corner], [x + width, y + radius],
    [x + width, y + height - radius, corner], [x + width - radius, y + height],
    [x + radius, y + height, corner], [x, y + height - radius],
    [x, y + radius, corner], [x + radius, y],
  ];
  write([0, 'LWPOLYLINE'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbPolyline'], [90, vertices.length], [70, 1]);
  for (const [vx, vy, bulge = 0] of vertices) write([10, vx], [20, vy], [42, bulge]);
}

write([0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [9, '$INSUNITS'], [70, 4],
  [9, '$MEASUREMENT'], [70, 1], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES']);
for (const x of cardPixels.x) {
  for (const y of cardPixels.y) {
    // The PDF rotates landscape artwork clockwise into portrait A4.
    roundedRectangle(matOffset + paperMillimeters.width - mm(y + cardPixels.height), matOffset + mm(x),
      mm(cardPixels.height), mm(cardPixels.width), cornerRadiusMillimeters);
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
