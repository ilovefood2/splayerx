import { describe, expect, it } from 'vitest';
import { generateMousedownAndMouseupListener } from '@/plugins/input/listeners';
import { defaultOptions, mutationTypes } from '@/plugins/input/constants';
import createInputState from '@/plugins/input/vuex/state';
import createInputMutations from '@/plugins/input/vuex/mutations';

describe('InputPlugin', () => {
  it('registers a correctly named mouseup listener', () => {
    const listeners = generateMousedownAndMouseupListener();

    expect(listeners.mouseup).toBeTypeOf('function');
    expect(listeners).not.toHaveProperty('mosueup');
  });

  it('tracks mouseup components and vertical wheel delta independently', () => {
    const state = createInputState(defaultOptions);
    const mutations = createInputMutations(defaultOptions);

    expect(state).toHaveProperty('mouseupComponentName', '');
    mutations[mutationTypes.WHEEL_DELTA_X](state, 4);
    mutations[mutationTypes.WHEEL_DELTA_Y](state, 12);

    expect(state.wheelDeltaX).toBe(4);
    expect(state.wheelDeltaY).toBe(12);
  });
});
