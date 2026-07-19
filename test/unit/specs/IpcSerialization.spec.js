import { reactive } from 'vue';
import { cloneIpcValue } from '@/ipcSerialization';

describe('renderer IPC serialization', () => {
  it('unwraps nested Vue reactive proxies into structured-clone values', () => {
    const channels = reactive([{
      category: 'video',
      channel: 'example',
      nested: { enabled: true },
    }]);
    const clone = cloneIpcValue(channels);

    expect(() => structuredClone(clone)).not.to.throw();
    expect(clone).to.deep.equal([{
      category: 'video',
      channel: 'example',
      nested: { enabled: true },
    }]);
  });

  it('preserves cycles while removing function properties', () => {
    const source = { action() {}, value: 7 };
    source.self = source;
    const clone = cloneIpcValue(reactive(source));

    expect(clone.action).to.equal(undefined);
    expect(clone.self).to.equal(clone);
    expect(() => structuredClone(clone)).not.to.throw();
  });
});
