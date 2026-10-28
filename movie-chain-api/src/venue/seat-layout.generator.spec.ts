import { describe, expect, it } from 'vitest';
import { generateLayout, LayoutError, rowLabel } from './seat-layout.generator';

describe('seat layout generator', () => {
  it('labels rows A…Z then AA, AB… (spreadsheet style)', () => {
    expect([0, 1, 25, 26, 27, 51].map(rowLabel)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ']);
  });

  it('generates rows × seats, front row A, numbered left to right', () => {
    const seats = generateLayout({ rows: 12, seatsPerRow: 20, defaultClass: 'standard' });
    expect(seats).toHaveLength(240);
    expect(seats[0]).toEqual({ rowLabel: 'A', seatNumber: 1, rowIndex: 0, colIndex: 0, seatClass: 'standard' });
    expect(seats.at(-1)).toMatchObject({ rowLabel: 'L', seatNumber: 20, rowIndex: 11, colIndex: 19 });
  });

  it('leaves a column gap after each aisle, without renumbering seats', () => {
    const row = generateLayout({ rows: 1, seatsPerRow: 10, defaultClass: 'standard', aisleAfter: [3, 7] });
    expect(row.map((s) => s.colIndex)).toEqual([0, 1, 2, 4, 5, 6, 7, 9, 10, 11]);
    expect(row.map((s) => s.seatNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('applies row classes, then individual seat classes on top', () => {
    const seats = generateLayout({
      rows: 3,
      seatsPerRow: 4,
      defaultClass: 'standard',
      rowClasses: [{ rows: ['C'], seatClass: 'vip' }],
      seatClasses: [{ seat: 'A1', seatClass: 'accessible' }, { seat: 'C2', seatClass: 'companion' }],
    });
    const cls = (s: string) => seats.find((x) => `${x.rowLabel}${x.seatNumber}` === s)!.seatClass;
    expect([cls('A1'), cls('A2'), cls('C1'), cls('C2')]).toEqual(['accessible', 'standard', 'vip', 'companion']);
  });

  it('rejects impossible specs', () => {
    expect(() => generateLayout({ rows: 0, seatsPerRow: 10, defaultClass: 'standard' })).toThrow(LayoutError);
    expect(() => generateLayout({ rows: 53, seatsPerRow: 10, defaultClass: 'standard' })).toThrow(LayoutError);
    expect(() => generateLayout({ rows: 2, seatsPerRow: 10, defaultClass: 'standard', aisleAfter: [10] })).toThrow(LayoutError);
    expect(() =>
      generateLayout({ rows: 2, seatsPerRow: 10, defaultClass: 'standard', seatClasses: [{ seat: 'Z1', seatClass: 'vip' }] }),
    ).toThrow(LayoutError);
  });
});
