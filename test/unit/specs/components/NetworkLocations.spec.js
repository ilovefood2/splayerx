import fs from 'fs';
import { shallowMount, flushPromises } from '@vue/test-utils';
import sinon from 'sinon';
import NetworkLocations from '@/components/LandingView/NetworkLocations.vue';
import asyncStorage from '@/helpers/asyncStorage';

describe('NetworkLocations', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('loads a favorite and opens it from the landing page', async () => {
    sandbox.stub(asyncStorage, 'get').resolves({
      locations: [{ name: 'TV Shows', path: '/Volumes/TV Shows' }],
    });
    sandbox.stub(fs.promises, 'stat').resolves({ isDirectory: () => true });
    const onOpen = sandbox.stub().resolves();
    const wrapper = shallowMount(NetworkLocations, {
      props: { onOpen },
      global: {
        mocks: {
          $t: (key, values) => (values ? `${key}:${values.name}` : key),
        },
      },
    });
    await flushPromises();

    expect(wrapper.findAll('.location-card')).to.have.lengthOf(1);
    await wrapper.get('.open-location').trigger('click');
    await flushPromises();

    sinon.assert.calledOnceWithExactly(onOpen, '/Volumes/TV Shows');
    wrapper.unmount();
  });

  it('saves and opens a newly selected mounted share', async () => {
    sandbox.stub(asyncStorage, 'get').resolves({});
    const save = sandbox.stub(asyncStorage, 'set').resolves();
    sandbox.stub(fs.promises, 'stat').resolves({ isDirectory: () => true });
    const onOpen = sandbox.stub().resolves();
    const showOpenDialog = sandbox.stub().resolves({
      canceled: false,
      filePaths: ['/Volumes/Media'],
      bookmarks: [],
    });
    const wrapper = shallowMount(NetworkLocations, {
      props: { onOpen },
      global: {
        mocks: {
          $electron: {
            remote: {
              app: { getPath: () => '/tmp' },
              dialog: { showOpenDialog },
            },
          },
          $t: key => key,
        },
      },
    });
    await flushPromises();

    await wrapper.get('.add-location').trigger('click');
    await flushPromises();

    sinon.assert.calledWithExactly(save, 'network-locations', {
      locations: [{ name: 'Media', path: '/Volumes/Media' }],
    });
    sinon.assert.calledOnceWithExactly(onOpen, '/Volumes/Media');
    wrapper.unmount();
  });
});
