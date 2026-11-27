// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { ApiClient } from '../api';

describe('cleanPrice', () => {
  it('parses Latin digits with commas', () => {
    expect(ApiClient.cleanPrice('1,234,567')).toBe('1,234,567');
  });

  it('normalizes Persian digits', () => {
    expect(ApiClient.cleanPrice('۱۲۳۴۵')).toBe('12345');
  });

  it('normalizes Arabic digits', () => {
    expect(ApiClient.cleanPrice('٥٦٧')).toBe('567');
  });

  it('handles Persian thousands separator U+066C', () => {
    expect(ApiClient.cleanPrice('۱٬۲۳۴٬۵۶۷')).toBe('1,234,567');
  });

  it('extracts number from mixed text', () => {
    expect(ApiClient.cleanPrice('قیمت: ۹۹٬۰۰۰ تومان')).toBe('99,000');
  });

  it('returns Error when no digits present', () => {
    expect(ApiClient.cleanPrice('no numbers here')).toBe('Error');
    expect(ApiClient.cleanPrice('')).toBe('Error');
  });
});

describe('FINANCE_ASSETS configuration', () => {
  it('defines all six live market assets with units and endpoints', async () => {
    const { FINANCE_ASSETS } = await import('../constants');
    expect(FINANCE_ASSETS.usdt.unit).toBe('toman');
    expect(FINANCE_ASSETS.usdt.nobitex).toBe('usdt-rls');
    expect(FINANCE_ASSETS.usdt.wallex).toBe('USDTTMN');
    expect(FINANCE_ASSETS.usd.tgju).toBe('price_dollar_rl');
    expect(FINANCE_ASSETS.gold.tgju).toBe('geram18');
    expect(FINANCE_ASSETS.eur.tgju).toBe('price_eur');
    expect(FINANCE_ASSETS.btc.unit).toBe('usd');
    expect(FINANCE_ASSETS.eth.unit).toBe('usd');
  });
});
