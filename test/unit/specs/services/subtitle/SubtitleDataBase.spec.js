import { reactive } from 'vue';
import { Format, Type } from '@/interfaces/ISubtitle';
import { LanguageCode } from '@/libs/language';
import { SubtitleDataBase } from '@/services/storage/subtitle/db';

describe('SubtitleDataBase structured-clone boundary', () => {
  it('stores reactive subtitle records without passing Vue proxies to IndexedDB', async () => {
    const db = new SubtitleDataBase();
    const subtitle = reactive({
      format: Format.SagiImage,
      hash: 'reactive-subtitle',
      language: LanguageCode.en,
      source: {
        type: Type.Embedded,
        source: reactive({ streamIndex: 4, videoPath: '/tmp/video.mkv' }),
      },
    });

    await db.addSubtitle(subtitle);

    expect(await db.retrieveSubtitle(subtitle.hash)).to.deep.equal({
      format: Format.SagiImage,
      hash: 'reactive-subtitle',
      language: LanguageCode.en,
      source: {
        type: Type.Embedded,
        source: { streamIndex: 4, videoPath: '/tmp/video.mkv' },
      },
      sources: [{
        type: Type.Embedded,
        source: { streamIndex: 4, videoPath: '/tmp/video.mkv' },
      }],
    });
  });

  it('stores reactive subtitle preferences without clone errors', async () => {
    const db = new SubtitleDataBase();
    const selected = reactive([{
      hash: 'reactive-subtitle',
      source: reactive({ streamIndex: 4, videoPath: '/tmp/video.mkv' }),
    }]);

    await db.storeSelectedSubtitles('media-hash', selected);

    expect(await db.retrieveSelectedSubtitles('media-hash')).to.deep.equal({
      primary: {
        hash: 'reactive-subtitle',
        source: { streamIndex: 4, videoPath: '/tmp/video.mkv' },
      },
      secondary: undefined,
    });
  });
});
