import { hitsPet } from '../renderer/components/pet-hit-test';

const mask = {
  width: 4,
  height: 2,
  alpha: new Uint8Array([0, 255, 255, 0, 0, 255, 8, 0]),
};
const rect = { left: 100, top: 50, width: 80, height: 80 };

it('passes through transparent margins and letterboxing of a scaled image', () => {
  expect(hitsPet(mask, rect, 110, 80)).toBe(false);
  expect(hitsPet(mask, rect, 130, 60)).toBe(false);
  expect(hitsPet(mask, rect, 130, 80)).toBe(true);
  expect(hitsPet(mask, rect, 180, 80)).toBe(false);
});

it('ignores almost transparent pixels and rechecks a changed frame', () => {
  expect(hitsPet(mask, rect, 150, 100)).toBe(false);
  expect(hitsPet(mask, rect, 130, 80)).toBe(true);
  expect(hitsPet({ ...mask, alpha: new Uint8Array(8) }, rect, 130, 80)).toBe(
    false,
  );
});

it('supports negative screen positions and zero-sized images', () => {
  expect(hitsPet(mask, { ...rect, left: -100 }, -70, 80)).toBe(true);
  expect(hitsPet(mask, { ...rect, width: 0 }, 130, 80)).toBe(false);
});
