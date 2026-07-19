import { nextTick } from 'vue';
import { mount, shallowMount } from '@vue/test-utils';
import sinon from 'sinon';
import BaseVideoPlayer from '@/components/PlayingView/BaseVideoPlayer.vue';

describe('Component - BaseVideoPlayer', () => {
  const propsData = {
    src: 'file:///',
    crossOrigin: 'anonymous',
    preload: 'auto',
    currentTime: [20],
    defaultPlaybackRate: 2,
    playbackRate: 1.5,
    autoplay: true,
    loop: false,
    controls: false,
    volume: 0.5,
    muted: false,
    defaultMuted: false,
    paused: false,
    events: ['loadedmetadata'],
    styles: {},
  };

  it('sanity - should render video element', () => {
    const wrapper = mount(BaseVideoPlayer, { props: propsData });

    expect(wrapper.find('video').exists()).to.equal(true);
  });

  it('keeps the fractional-opacity workaround Windows-only', () => {
    const wrapper = mount(BaseVideoPlayer, { props: propsData });
    const video = wrapper.find('video');

    expect(video.classes().includes('windows-video-opacity-workaround'))
      .to.equal(process.platform === 'win32');
    if (process.platform === 'darwin') expect(video.element.style.opacity).to.equal('');
    wrapper.unmount();
  });

  it('uses a canvas for macOS compatibility streams only', () => {
    const wrapper = mount(BaseVideoPlayer, {
      props: {
        ...propsData,
        src: 'http://127.0.0.1:49152/compat/token/video.mkv.mp4?start=0',
      },
    });
    const shouldUseCanvas = process.platform === 'darwin';

    expect(wrapper.classes().includes('compatibility-canvas-player'))
      .to.equal(shouldUseCanvas);
    expect(wrapper.find('canvas').exists()).to.equal(shouldUseCanvas);
    wrapper.unmount();
  });

  describe('Props', () => {
    let sandbox;
    let wrapper;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      wrapper = shallowMount(BaseVideoPlayer, {
        props: propsData,
      });
    });
    afterEach(() => {
      sandbox.restore();
      wrapper.unmount();
    });

    async function assertVideoAttributes(attribute, rawValue, changedValues, changeOrNot) {
      for (const testCase of changedValues) {
        await wrapper.setProps({ [attribute]: testCase });
        await nextTick();
        const changedValue = wrapper.element.childNodes[0][attribute];

        expect(changedValue).to.equal(changeOrNot ? testCase : rawValue);
      }
    }

    describe('Mutable Props', () => {
      it('should currentTime be changed dynamically', async () => {
        const currentTimes = [[10], [30], [40], [50]];

        for (const currentTime of currentTimes) {
          await wrapper.setProps({ currentTime });

          await nextTick();
          const changedCurrentTime = wrapper.element.childNodes[0].currentTime;

          expect(changedCurrentTime).to.equal(currentTime[0]);
        }
      });

      it('should playbackRate be changed dynamically', async () => {
        await assertVideoAttributes('playbackRate', propsData.playbackRate, [3, 4, 5, 8], true);
      });

      it('should loop be changed dynamically', async () => {
        await assertVideoAttributes('loop', propsData.loop, [true], true);
      });

      it('should controls be changed dynamically', async () => {
        await assertVideoAttributes('controls', propsData.controls, [true], true);
      });

      it('should volume be changed dynamically', async () => {
        await assertVideoAttributes('volume', propsData.volume, [0.9, 0.3, 0.2, 1], true);
      });

      it('should muted be changed dynamically', async () => {
        await assertVideoAttributes('muted', propsData.muted, [true], true);
      });

      it('should video be dynamically paused', async () => {
        await assertVideoAttributes('paused', propsData.paused, [true], true);
      });

      it('should events be dynamically added', async () => {
        const finalEvents = ['loadedmetadata', 'canplay'];
        wrapper.setProps({
          events: finalEvents,
        });

        await nextTick();
        finalEvents.forEach((event) => {
          expect(wrapper.vm.eventListeners.get(event)).to.not.equal(undefined);
        });
      });

      it('should events be dynamically removed', async () => {
        wrapper.setProps({ events: [] });

        await nextTick();
        propsData.events.forEach((event) => {
          expect(wrapper.vm.eventListeners.get(event)).to.equal(undefined);
        });
      });

      it('should styles be dynamically changed', async () => {
        const testStyle = {
          objectFit: 'cover',
          width: '100%',
        };

        wrapper.setProps({ styles: testStyle });

        await nextTick();
        Object.keys(testStyle).forEach((style) => {
          expect(wrapper.element.childNodes[0].style[style]).to.equal(testStyle[style]);
        });
      });
    });

    describe('Immutable Props', () => {
      it('should crossOrigin not be changed dynamically', async () => {
        await assertVideoAttributes('crossOrigin', propsData.crossOrigin, [!propsData.crossOrigin], false);
      });

      it('should preload not be changed dynamically', async () => {
        await assertVideoAttributes('preload', propsData.preload, [!propsData.preload], false);
      });

      it('should autoplay not be changed dynamically', async () => {
        await assertVideoAttributes('autoplay', propsData.autoplay, [!propsData.autoplay], false);
      });

      it('should defaultMuted not be changed dynamically', async () => {
        await assertVideoAttributes('defaultMuted', propsData.defaultMuted, [!propsData.defaultMuted], false);
      });
    });
  });

  describe('Methods', () => {
    let sandbox;
    let clock;
    let wrapper;
    const propsData = {
      src: 'file:///',
      events: ['loadedmetadata'],
    };

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      clock = sinon.useFakeTimers();
      wrapper = mount(BaseVideoPlayer, { props: propsData });
    });
    afterEach(() => {
      sandbox.restore();
      clock.restore();
      wrapper.unmount();
    });

    it('should videoElement return actual videoElement', () => {
      const videoElement = wrapper.vm.videoElement();

      expect(videoElement).to.equal(wrapper.vm.$refs.video);
    });

    it('recognizes local Matroska compatibility streams', () => {
      const compatibilityWrapper = mount(BaseVideoPlayer, {
        props: {
          src: 'http://127.0.0.1:54321/compat/token/movie.mkv.mp4?start=0',
          events: ['loadedmetadata'],
        },
      });

      expect(compatibilityWrapper.vm.isCompatibilityStream()).to.equal(true);
      if (process.platform === 'darwin') {
        expect(compatibilityWrapper.vm.$refs.video.hwhevc).to.equal(false);
      }
      compatibilityWrapper.unmount();
    });

    it('should emitEvents emit events', () => {
      const testEvents = ['loadedmetadata', 'canplay', 'someotherevent'];

      testEvents.forEach((event) => {
        wrapper.vm.emitEvents(event);
      });

      expect(Object.keys(wrapper.emitted())).to.deep.equal(testEvents);
    });

    it('should emitEvents emit events with payloads', () => {
      const testEvents = {
        loadedmetadata: true,
        canplaytype: ['mkv', 'mp3'],
        someotherevent: () => 1 + 1,
      };

      Object.keys(testEvents).forEach((event) => {
        wrapper.vm.emitEvents(event, testEvents[event]);
      });

      Object.keys(wrapper.emitted()).forEach((event) => {
        expect(wrapper.emitted()[event][0][0]).to.equal(testEvents[event]);
      });
    });
  });
});
