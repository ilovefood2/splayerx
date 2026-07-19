import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import sinon from 'sinon';
import BaseImageDisplay from '@/components/PlayingView/BaseImageDisplay.vue';

describe('Component - BaseImageDisplay', () => {
  let sandbox;
  let wrapper;

  it('sanity - should BaseImageDisplay be rendered properly', () => {
    wrapper = mount(BaseImageDisplay, { props: { imgSrc: 'https://' } });

    expect(wrapper.findComponent(BaseImageDisplay).exists()).to.equal(true);
  });

  describe('Functionality - render imgSrc test', () => {
    beforeEach(() => {
      sandbox = sinon.createSandbox();
    });
    afterEach(() => {
      sandbox.restore();
      if (wrapper) wrapper.unmount();
    });

    it('should render DataURI to img', () => {
      const propsData = { imgSrc: 'data:image/gif' };

      wrapper = mount(BaseImageDisplay, { props: propsData });

      expect(wrapper.find('img').exists()).to.equal(true);
    });
    it('should render URL to img', () => {
      const propsData = { imgSrc: 'https://localhost:9090/example.png' };

      wrapper = mount(BaseImageDisplay, { props: propsData });

      expect(wrapper.find('img').exists()).to.equal(true);
    });
    it('should render Blob to img', () => {
      const propsData = { imgSrc: new Blob(new Uint8Array(1)) };

      wrapper = mount(BaseImageDisplay, { props: propsData });

      expect(wrapper.find('img').exists()).to.equal(true);
    });
    // Todo: should render ImageBitmap to canvas
    it('should render ImageData to canvas', () => {
      const propsData = { imgSrc: new ImageData(20, 10) };

      wrapper = mount(BaseImageDisplay, { props: propsData });

      expect(wrapper.find('canvas').exists()).to.equal(true);
    });
    it('should render unsupported types to span', () => {
      const propsData = { imgSrc: 'image://' };

      wrapper = mount(BaseImageDisplay, { props: propsData });

      expect(wrapper.find('span').exists()).to.equal(true);
    });
    it('should rendered element be dynamiacally changed', async () => {
      let propsData = { imgSrc: 'https://localhost:9090/example.png' };

      wrapper = mount(BaseImageDisplay, { props: propsData });

      expect(wrapper.find('img').exists()).to.equal(true);

      propsData = { imgSrc: new ImageData(20, 10) };

      wrapper.setProps(propsData);

      await nextTick();
      expect(wrapper.find('canvas').exists()).to.equal(true);
    });
    it('should render element with attributes', () => {
      const propsData = {
        imgSrc: new Blob(new Uint8Array(1)),
        attributes: {
          id: 'xxx-imagedata',
          width: '20px',
          ref: 'test-image',
        },
      };

      wrapper = mount(BaseImageDisplay, { props: propsData });

      expect(wrapper.attributes()).to.include({
        id: propsData.attributes.id,
        width: propsData.attributes.width,
      });
    });
    it('should render element with styles', () => {
      const propsData = {
        imgSrc: new Blob(new Uint8Array(1)),
        imageStyle: {
          objectFit: 'cover',
        },
      };

      wrapper = mount(BaseImageDisplay, { props: propsData });

      expect(wrapper.element.style).to.contains(propsData.imageStyle);
    });
    it('should render element with width and height', () => {
      const propsData = {
        imgSrc: new ImageData(10, 20),
        width: 240,
        height: 135,
      };

      wrapper = mount(BaseImageDisplay, { props: propsData });

      expect(wrapper.attributes().width).to.equal(`${propsData.width}px`);
      expect(wrapper.attributes().height).to.equal(`${propsData.height}px`);
    });
  });
});
