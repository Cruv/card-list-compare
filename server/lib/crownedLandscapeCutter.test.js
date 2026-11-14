import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const template = new URL('../../public/print-templates/crowned-a4-landscape-v2.dxf', import.meta.url);
const geometry = JSON.parse(readFileSync(new URL('./crownedLandscapeGeometry.json', import.meta.url), 'utf8'));

function readEntities(records) {
  const start = records.findIndex(([code, value]) => code === 2 && value === 'ENTITIES');
  expect(start).toBeGreaterThanOrEqual(0);
  const entities = [];
  for (const [code, value] of records.slice(start + 1)) {
    if (code === 0 && value === 'ENDSEC') break;
    if (code === 0) entities.push({ type: value, fields: new Map() });
    else entities.at(-1).fields.set(code, value);
  }
  return entities;
}

it('exports eight closed R13 cut outlines with straight sides and rounded corners at the PDF card positions', () => {
  const lines = readFileSync(template, 'utf8').trimEnd().split(/\r?\n/);
  expect(lines.length % 2).toBe(0);
  const records = [];
  for (let i = 0; i < lines.length; i += 2) records.push([Number(lines[i]), lines[i + 1].trim()]);
  const version = records.findIndex(([code, value]) => code === 9 && value === '$ACADVER');
  expect(version).toBeGreaterThanOrEqual(0);
  expect(records[version + 1]).toEqual([1, 'AC1012']);

  const entities = readEntities(records);
  const pathStarts = entities.flatMap(({ type }, index) => type === 'POLYLINE' ? [index] : []);
  expect(pathStarts).toHaveLength(8);
  expect(pathStarts[0]).toBe(0);
  const { cardPixels, paperMillimeters, cornerRadiusMillimeters: radius } = geometry;
  expect(paperMillimeters).toEqual({ width: 297, height: 210 });
  expect(cardPixels.x).toEqual([244, 1003, 1762, 2521]);
  expect(cardPixels.y).toEqual([194, 1248]);
  const mm = pixels => pixels * 25.4 / cardPixels.ppi;
  const width = mm(cardPixels.width);
  const height = mm(cardPixels.height);
  const expectedPositions = cardPixels.y.flatMap(y => cardPixels.x.map(x => [mm(x), mm(y)]));

  for (const [index, start] of pathStarts.entries()) {
    const [header, ...components] = entities.slice(start, pathStarts[index + 1]);
    expect(header.fields.get(70)).toBe('1');
    expect(components.pop()?.type).toBe('SEQEND');
    expect(components.length).toBeGreaterThan(8);
    const points = components.map(({ type, fields }) => {
      expect(type).toBe('VERTEX');
      expect(fields.has(42)).toBe(false);
      return [Number(fields.get(10)), Number(fields.get(20))];
    });
    const x = points.map(point => point[0]);
    const y = points.map(point => point[1]);
    const left = Math.min(...x);
    const top = Math.max(...y);
    expect(left).toBeCloseTo(expectedPositions[index][0], 4);
    expect(paperMillimeters.height - top).toBeCloseTo(expectedPositions[index][1], 4);
    expect(Math.max(...x) - left).toBeCloseTo(width, 4);
    expect(top - Math.min(...y)).toBeCloseTo(height, 4);

    const edges = points.map((point, i) => [point, points[(i + 1) % points.length]]);
    for (const [axis, size] of [[0, width], [1, height]]) {
      const straightSides = edges.filter(([a, b]) => a[1 - axis] === b[1 - axis] && Math.abs(a[axis] - b[axis]) > size / 2);
      expect(straightSides).toHaveLength(2);
      for (const [a, b] of straightSides) expect(Math.abs(a[axis] - b[axis])).toBeCloseTo(size - 2 * radius, 4);
    }
    const area = edges.reduce((sum, [[x1, y1], [x2, y2]]) => sum + x1 * y2 - x2 * y1, 0) / 2;
    const roundedArea = width * height - (4 - Math.PI) * radius ** 2;
    expect(Math.abs(area - roundedArea)).toBeLessThan(0.25);
  }
});
