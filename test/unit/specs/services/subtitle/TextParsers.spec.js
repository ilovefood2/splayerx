import sinon from 'sinon';
import { SrtParser } from '@/services/subtitle/parsers/srt';
import { VttParser } from '@/services/subtitle/parsers/vtt';

function createLoader(payload) {
  return {
    fullyRead: false,
    async getPayload() {
      this.fullyRead = true;
      return payload;
    },
  };
}

describe('text subtitle parser resilience', () => {
  [
    ['SRT', SrtParser],
    ['VTT', VttParser],
  ].forEach(([name, Parser]) => {
    it(`${name} returns no cues for an empty subtitle`, async () => {
      const videoSegments = { insert: sinon.spy() };
      const parser = new Parser(createLoader('   '), videoSegments);

      expect(await parser.getDialogues()).to.deep.equal([]);
      expect(videoSegments.insert).not.to.have.been.called;
    });

    it(`${name} returns no cues when the subtitle parser rejects malformed input`, async () => {
      const videoSegments = { insert: sinon.spy() };
      const parser = new Parser(createLoader(null), videoSegments);

      expect(await parser.getDialogues()).to.deep.equal([]);
      expect(videoSegments.insert).not.to.have.been.called;
    });
  });
});
