import { normalizeExternalUrl } from '../../../../src/main/helpers/externalUrl';

describe('external URL validation', () => {
  it('allows and normalizes HTTP(S) URLs', () => {
    expect(normalizeExternalUrl('https://splayer.org/help')).to.equal(
      'https://splayer.org/help',
    );
    expect(normalizeExternalUrl('HTTP://example.com')).to.equal('http://example.com/');
  });

  it('rejects local files, custom protocols, and malformed input', () => {
    expect(() => normalizeExternalUrl('file:///tmp/payload')).to.throw(
      'Unsupported external URL protocol',
    );
    expect(() => normalizeExternalUrl('ms-settings:defaultapps')).to.throw(
      'Unsupported external URL protocol',
    );
    expect(() => normalizeExternalUrl('not a url')).to.throw();
    expect(() => normalizeExternalUrl('')).to.throw('non-empty string');
  });
});
