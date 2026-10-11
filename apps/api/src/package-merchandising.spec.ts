import { BadRequestException } from '@nestjs/common';
import { normalizePackageMerchandising } from './package-merchandising';

describe('package merchandising normalization', () => {
  it('accepts HTTPS and local relative cover references', () => {
    expect(normalizePackageMerchandising({ coverImageUrl: 'https://cdn.example.test/cover.jpg', tags: ['招牌', '招牌'] }, 3990)).toEqual(expect.objectContaining({ coverImageUrl: 'https://cdn.example.test/cover.jpg', tags: ['招牌'] }));
    expect(normalizePackageMerchandising({ coverImageUrl: '/media/cover.jpg' }, 3990).coverImageUrl).toBe('/media/cover.jpg');
  });

  it('rejects active content schemes and invalid original prices', () => {
    expect(() => normalizePackageMerchandising({ coverImageUrl: 'javascript:alert(1)' }, 3990)).toThrow(BadRequestException);
    expect(() => normalizePackageMerchandising({ coverImageUrl: '//evil.example.test/cover.jpg' }, 3990)).toThrow(BadRequestException);
    expect(() => normalizePackageMerchandising({ originalPriceFen: 2990 }, 3990)).toThrow(BadRequestException);
  });
});
