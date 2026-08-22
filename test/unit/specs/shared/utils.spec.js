import {
  getValidSubtitleExtensions,
  getValidVideoExtensions,
  getValidImageExtensions,
  isSubtitle,
  isVideo,
  isImage,
  isValidFile,
} from '@/../shared/utils';

describe('shared/utils', () => {
  it('should contains proper subtitle extensions', () => {
    expect(getValidSubtitleExtensions()).to.include('srt');
    expect(getValidSubtitleExtensions()).to.not.include('mp4');
    expect(isSubtitle('filename.vtt')).to.be.equal(true);
    expect(isSubtitle('filename.ASS')).to.be.equal(true);
  });

  it('should contains proper video extensions', () => {
    expect(getValidVideoExtensions()).to.include('mp4');
    expect(getValidVideoExtensions()).to.not.include('srt');
    expect(isVideo('filename.mkv')).to.be.equal(true);
    expect(isVideo('filename.WMV')).to.be.equal(true);
  });

  it('should recognize browser-displayable image files as media', () => {
    expect(getValidImageExtensions()).to.include.members(['jpg', 'png', 'webp']);
    expect(isImage('filename.PNG')).to.equal(true);
    expect(isImage('filename.mp4')).to.equal(false);
    expect(isValidFile('filename.jpg')).to.equal(true);
  });

  it('should not be able to modify', () => {
    expect(() => getValidSubtitleExtensions().push('')).to.throw();
    expect(() => getValidVideoExtensions().push('')).to.throw();
    expect(() => getValidImageExtensions().push('')).to.throw();
  });
});
