import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('csv', () => {
  it('quotes, escapes and neutralises formulas', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'he said "hi"'], ['=HYPERLINK("evil")', -5], [null, '@SUM(A1)']])).toBe(
      'a,b\r\n"x,y","he said ""hi"""\r\n"\'=HYPERLINK(""evil"")",-5\r\n,\'@SUM(A1)\r\n',
    );
  });
});
