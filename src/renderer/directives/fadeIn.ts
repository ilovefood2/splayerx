import type { Directive } from 'vue';

function updateFadeState(el: HTMLElement, value: unknown) {
  el.classList.toggle('fade-in', Boolean(value));
  el.classList.toggle('fade-out', !value);
}

export const fadeInDirective: Directive<HTMLElement, unknown> = {
  beforeMount(el, binding) {
    updateFadeState(el, binding.value);
  },
  updated(el, binding) {
    if (binding.oldValue !== binding.value) updateFadeState(el, binding.value);
  },
};
