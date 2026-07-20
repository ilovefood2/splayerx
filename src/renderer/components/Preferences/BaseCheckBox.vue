<template>
  <div class="checkbox">
    <label
      :style="{
        fontSize: `${labelSize}px`,
      }"
      class="checkbox__label"
    >
      <slot />
      <input
        :checked="checkedValue"
        @change="handleChange"
        type="checkbox"
        class="checkbox__input"
      >
      <span
        :class="{ 'checkbox__checkmark--checked': checkedValue }"
        class="checkbox__checkmark"
      />
    </label>
  </div>
</template>

<script lang="ts">
export default {
  name: 'BaseCheckBox',
  emits: ['input', 'update:modelValue'],
  props: {
    // Templates still compile in Vue 2 compatibility mode, where v-model
    // supplies `value`/`input`. Also support Vue 3's explicit binding pair.
    value: {
      type: Boolean,
      default: undefined,
    },
    modelValue: {
      type: Boolean,
      default: undefined,
    },
    labelSize: {
      type: String,
      default: '14',
    },
  },
  computed: {
    checkedValue() {
      return this.value === undefined ? !!this.modelValue : this.value;
    },
  },
  methods: {
    handleChange(event: Event) {
      const checked = (event.target as HTMLInputElement).checked;
      this.$emit('input', checked);
      this.$emit('update:modelValue', checked);
    },
  },
};
</script>

<style scoped lang="scss">
.checkbox {
  -webkit-app-region: no-drag;
  margin-top: 15px;
  width: fit-content;
  position: relative;

  &__label {
    display: block;
    cursor: pointer;
    padding-left: 29px;
    font-family: $font-medium;
    color: rgba(255,255,255,0.7);
    letter-spacing: 0.3px;
    line-height: 19px;
    user-select: none;
  }

  &__checkmark {
    position: absolute;
    top: 0;
    left: 0;
    width: 17px;
    height: 17px;
    border-radius: 2px;
    border: 1px solid rgba(255,255,255,0.1);
    background-color: rgba(255,255,255,0.03);
    transition: border 200ms, background-color 200ms;

    &--checked::after {
      content: '';
      position: absolute;
      left: 5px;
      top: 2px;
      width: 5px;
      height: 9px;
      border: solid rgba(255,255,255,0.8);
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
  }

  &:hover .checkbox__checkmark {
    border: 1px solid rgba(255,255,255,0.2);
    background-color: rgba(255,255,255,0.1);
  }

  &__input {
    position: absolute;
    width: 17px;
    height: 17px;
    left: 0;
    top: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
    z-index: 1;
  }
}
</style>
