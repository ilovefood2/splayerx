<template>
  <div class="privicy tabcontent">
    <div class="settingItem">
      <BaseCheckBox v-model="privacyAgreement">
        {{ $t('preferences.translate.translateConfirm') }}
      </BaseCheckBox>
      <div
        :style="{opacity: privacyAgreement ? 1 : 0.3}"
        class="settingItem__attached"
      >
        <div class="settingItem__title">
          {{ $t('preferences.translate.languagePriority') }}
        </div>
        <div class="settingItem__description">
          {{ $t('preferences.translate.languageDescription') }}
        </div>
        <table>
          <tr>
            <td class="dropdown__title">
              {{ $t('preferences.translate.primary') }}
            </td>
            <td>
              <div class="settingItem__input dropdown">
                <div
                  :class="showFirstSelection ?
                    'dropdown__toggle--list' : 'dropdown__toggle--display'"
                  :style="{ cursor: privacyAgreement ? 'pointer' : 'default' }"
                  @mouseup.stop="openFirstDropdown"
                >
                  <div class="dropdown__displayItem">
                    {{ codeToLanguageName(primaryLanguage) }}
                  </div>
                  <div
                    @mouseup.stop=""
                    class="dropdown__listItems"
                  >
                    <div
                      v-for="(language, index) in primaryLanguages"
                      :key="index"
                      @mouseup.stop="handleFirstSelection(language)"
                      class="dropdownListItem"
                    >
                      {{ codeToLanguageName(language) }}
                    </div>
                  </div>
                  <Icon
                    :class="showFirstSelection ?
                      'dropdown__icon--arrowUp' : 'dropdown__icon--arrowDown'"
                    type="rightArrow"
                  />
                </div>
              </div>
            </td>
          </tr>
          <tr>
            <td class="dropdown__title">
              {{ $t('preferences.translate.secondary') }}
            </td>
            <td>
              <div class="settingItem__input dropdown">
                <div
                  :class="showSecondSelection ?
                    'dropdown__toggle--list' : 'dropdown__toggle--display'"
                  :style="{ cursor: privacyAgreement ? 'pointer' : 'default' }"
                  @mouseup.stop="openSecondDropdown"
                >
                  <div class="dropdown__displayItem">
                    {{ codeToLanguageName(secondaryLanguage) }}
                  </div>
                  <div
                    @mouseup.stop=""
                    class="dropdown__listItems"
                  >
                    <div
                      ref="secondarySelection"
                      v-for="(language, index) in secondaryLanguages"
                      :key="index"
                      :style="{
                        color: (language === primaryLanguage && language !== noLanguage) ?
                          'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.7)',
                      }"
                      @mouseup.stop="handleSecondSelection(language)"
                      class="dropdownListItem"
                    >
                      {{ codeToLanguageName(language) }}
                      <span
                        v-if="language === primaryLanguage && language !== noLanguage"
                        style="color: rgba(255,255,255,0.25)"
                      >- {{ $t('preferences.translate.primary') }}</span>
                    </div>
                  </div>
                  <Icon
                    :class="showSecondSelection ?
                      'dropdown__icon--arrowUp' : 'dropdown__icon--arrowDown'"
                    type="rightArrow"
                  />
                </div>
              </div>
            </td>
          </tr>
        </table>
      </div>
      <BaseCheckBox
        v-model="enableQuickEdit"
        class="quick_edit"
      >
        {{ $t("preferences.translationEdit.quickEdit") }}
      </BaseCheckBox>
      <div class="settingItem__description">
        {{ $t('preferences.translationEdit.quickEditDescription') }}
      </div>
    </div>
    <div class="settingItem aiTranslate">
      <BaseCheckBox v-model="aiTranslateEnabled">
        {{ $t('preferences.translate.aiTranslateEnable') }}
      </BaseCheckBox>
      <div
        :style="{ opacity: aiTranslateEnabled ? 1 : 0.3 }"
        class="settingItem__attached"
      >
        <div class="settingItem__description">
          {{ $t('preferences.translate.aiTranslateDescription') }}
        </div>
        <table class="aiTranslate__table">
          <tr>
            <td class="aiTranslate__label">
              {{ $t('preferences.translate.aiProvider') }}
            </td>
            <td>
              <select
                v-model="aiTranslateProvider"
                :disabled="!aiTranslateEnabled"
                class="aiTranslate__input"
              >
                <option value="auto">
                  {{ $t('preferences.translate.aiProviderAuto') }}
                </option>
                <option value="local">
                  {{ $t('preferences.translate.aiProviderLocal') }}
                </option>
                <option value="openai">
                  {{ $t('preferences.translate.aiProviderOpenai') }}
                </option>
              </select>
            </td>
          </tr>
          <tr>
            <td class="aiTranslate__label" />
            <td>
              <div class="aiTranslate__status">
                <span>{{ providerStatus }}</span>
                <button
                  :disabled="!aiTranslateEnabled || detecting"
                  @click="detectProvider"
                  class="aiTranslate__redetect"
                  type="button"
                >{{ $t('preferences.translate.aiRedetect') }}</button>
              </div>
            </td>
          </tr>
          <tr>
            <td class="aiTranslate__label">
              {{ $t('preferences.translate.aiApiUrl') }}
            </td>
            <td>
              <input
                v-model.trim="aiTranslateApiUrl"
                :disabled="!aiTranslateEnabled || aiTranslateProvider === 'local'"
                :placeholder="defaultApiUrl"
                class="aiTranslate__input"
                spellcheck="false"
              >
            </td>
          </tr>
          <tr>
            <td class="aiTranslate__label">
              {{ $t('preferences.translate.aiApiKey') }}
            </td>
            <td>
              <input
                v-model.trim="aiTranslateApiKey"
                :disabled="!aiTranslateEnabled || aiTranslateProvider === 'local'"
                type="password"
                class="aiTranslate__input"
                spellcheck="false"
                autocomplete="off"
              >
            </td>
          </tr>
          <tr>
            <td class="aiTranslate__label">
              {{ $t('preferences.translate.aiModel') }}
            </td>
            <td>
              <input
                v-model.trim="aiTranslateModel"
                :disabled="!aiTranslateEnabled || aiTranslateProvider === 'local'"
                :placeholder="defaultModel"
                class="aiTranslate__input"
                spellcheck="false"
              >
            </td>
          </tr>
          <tr>
            <td class="aiTranslate__label">
              {{ $t('preferences.translate.aiSpokenLanguage') }}
            </td>
            <td>
              <select
                v-model="aiTranscribeLanguage"
                :disabled="!aiTranslateEnabled"
                class="aiTranslate__input"
              >
                <option value="">
                  {{ $t('preferences.translate.aiSpokenAuto') }}
                </option>
                <option
                  v-for="code in supportedLanguageCodes"
                  :key="code"
                  :value="code"
                >
                  {{ codeToLanguageName(code) }}
                </option>
              </select>
            </td>
          </tr>
          <tr>
            <td class="aiTranslate__label">
              {{ $t('preferences.translate.aiTargetLanguage') }}
            </td>
            <td>
              <select
                v-model="aiTranslateTargetLanguage"
                :disabled="!aiTranslateEnabled"
                class="aiTranslate__input"
              >
                <option value="">
                  {{ $t('preferences.translate.aiTargetAuto') }}
                </option>
                <option
                  v-for="code in supportedLanguageCodes"
                  :key="code"
                  :value="code"
                >
                  {{ codeToLanguageName(code) }}
                </option>
              </select>
            </td>
          </tr>
        </table>
      </div>
    </div>
  </div>
</template>

<script>
import { concat } from 'lodash';
import electron from 'electron';
import { codeToLanguageName, LanguageCode } from '@/libs/language';
import {
  DEFAULT_BASE_URL, DEFAULT_MODEL, MANAGED_MODEL_ALIAS,
  inspectManagedModel, resolveAIProvider,
} from '@/services/subtitle/ai';
import Icon from '@/components/BaseIconContainer.vue';
import BaseCheckBox from './BaseCheckBox.vue';

export default {
  name: 'Translate',
  components: {
    Icon,
    BaseCheckBox,
  },
  props: {
    mouseDown: Boolean,
    isMoved: Boolean,
    supportedLanguageCodes: {
      type: Array,
      default: () => [
        LanguageCode.en,
        LanguageCode['zh-CN'],
        LanguageCode['zh-TW'],
        LanguageCode.ja,
        LanguageCode.ko,
        LanguageCode.es,
        LanguageCode.fr,
        LanguageCode.de,
        LanguageCode.it,
        LanguageCode.pt,
        LanguageCode.cs,
        LanguageCode.ru,
        LanguageCode.id,
        LanguageCode.ar,
        LanguageCode.tr,
        LanguageCode.nl,
        LanguageCode.ro,
      ],
    },
  },
  data() {
    return {
      showFirstSelection: false,
      showSecondSelection: false,
      noLanguage: this.$t('preferences.translate.none'),
      detecting: false,
      resolution: null,
      managedStatus: null,
      detectToken: 0,
    };
  },
  computed: {
    languages() {
      return concat('', this.supportedLanguageCodes);
    },
    primaryLanguages() {
      return this.languages.filter(language => language && language !== this.primaryLanguage);
    },
    secondaryLanguages() {
      return this.languages.filter(language => language !== this.secondaryLanguage);
    },
    preferenceData() {
      return this.$store.getters.preferenceData;
    },
    primaryLanguage: {
      get() {
        return this.$store.getters.primaryLanguage;
      },
      set(val) {
        this.$store.dispatch('primaryLanguage', val).then(() => {
          electron.ipcRenderer.send('preference-to-main', this.preferenceData);
        });
      },
    },
    secondaryLanguage: {
      get() {
        return this.$store.getters.secondaryLanguage;
      },
      set(val) {
        this.$store.dispatch('secondaryLanguage', val).then(() => {
          electron.ipcRenderer.send('preference-to-main', this.preferenceData);
        });
      },
    },
    privacyAgreement: {
      get() {
        return this.$store.getters.privacyAgreement;
      },
      set(val) {
        if (val) {
          this.$store.dispatch('agreeOnPrivacyPolicy').then(() => {
            electron.ipcRenderer.send('preference-to-main', this.preferenceData);
          });
        } else {
          this.$store.dispatch('disagreeOnPrivacyPolicy').then(() => {
            electron.ipcRenderer.send('preference-to-main', this.preferenceData);
          });
        }
      },
    },
    enableQuickEdit: {
      get() {
        return !this.$store.getters.disableQuickEdit;
      },
      set(val) {
        this.$store.dispatch('quickEditStatus', !val).then(() => {
          electron.ipcRenderer.send('preference-to-main', this.preferenceData);
        });
      },
    },
    usesManagedModel() {
      return this.aiTranslateProvider === 'local'
        || (this.aiTranslateProvider === 'auto' && !this.aiTranslateApiKey);
    },
    defaultApiUrl() {
      return DEFAULT_BASE_URL;
    },
    defaultModel() {
      if (this.usesManagedModel) return MANAGED_MODEL_ALIAS;
      return DEFAULT_MODEL;
    },
    /** Plain-language summary of which provider will actually be used, and why. */
    providerStatus() {
      if (!this.aiTranslateEnabled) return '';
      if (this.usesManagedModel) {
        const status = this.managedStatus;
        if (!status) return '';
        if (!status.runtimeAvailable) {
          return this.$t('preferences.translate.aiStatusLocalRuntimeMissing');
        }
        if (status.modelDownloaded) {
          return this.$t('preferences.translate.aiStatusLocalReady');
        }
        return this.$t('preferences.translate.aiStatusLocalDownload');
      }
      if (this.detecting) return this.$t('preferences.translate.aiStatusDetecting');
      const resolved = this.resolution;
      if (!resolved) return '';
      if (resolved.ok) return this.$t('preferences.translate.aiStatusOpenai');
      if (resolved.reason === 'missing-key') return this.$t('preferences.translate.aiStatusMissingKey');
      return '';
    },
    aiTranslateEnabled: {
      get() {
        return this.$store.getters.aiTranslateEnabled;
      },
      set(val) {
        this.persistAI({ aiTranslateEnabled: val });
      },
    },
    aiTranslateProvider: {
      get() {
        return this.$store.getters.aiTranslateProvider;
      },
      set(val) {
        this.persistAI({ aiTranslateProvider: val });
        this.detectProvider();
      },
    },
    aiTranslateApiUrl: {
      get() {
        return this.$store.getters.aiTranslateApiUrl;
      },
      set(val) {
        this.persistAI({ aiTranslateApiUrl: val });
        this.detectProvider();
      },
    },
    aiTranslateApiKey: {
      get() {
        return this.$store.getters.aiTranslateApiKey;
      },
      set(val) {
        this.persistAI({ aiTranslateApiKey: val });
        this.detectProvider();
      },
    },
    aiTranslateModel: {
      get() {
        return this.$store.getters.aiTranslateModel;
      },
      set(val) {
        this.persistAI({ aiTranslateModel: val });
      },
    },
    aiTranslateTargetLanguage: {
      get() {
        return this.$store.getters.aiTranslateTargetLanguage;
      },
      set(val) {
        this.persistAI({ aiTranslateTargetLanguage: val });
      },
    },
    aiTranscribeLanguage: {
      get() {
        return this.$store.getters.aiTranscribeLanguage;
      },
      set(val) {
        this.persistAI({ aiTranscribeLanguage: val });
      },
    },
  },
  mounted() {
    this.detectProvider();
  },
  watch: {
    aiTranslateEnabled() {
      // Route both directions through detectProvider: it clears the status when
      // disabled AND invalidates any probe still in flight.
      this.detectProvider();
    },
    privacyAgreement(val) {
      if (!val) {
        this.showFirstSelection = this.showSecondSelection = false;
      }
    },
    mouseDown(val, oldVal) {
      if (!val && oldVal && !this.isMoved) {
        this.showFirstSelection = this.showSecondSelection = false;
      } else if (!val && oldVal && this.isMoved) {
        this.$emit('move-stoped');
      }
    },
  },
  methods: {
    codeToLanguageName(code) {
      if (!code) return this.noLanguage;
      return codeToLanguageName(code);
    },
    /** Ask the same resolver playback uses, so the status line cannot drift from reality. */
    detectProvider() {
      // Bump first, so any probe already in flight is invalidated. Typing in the
      // endpoint field fires one probe per keystroke and they finish out of
      // order; without this a stale answer can overwrite a newer one — or
      // repopulate the status after the feature has been switched off.
      this.detectToken += 1;
      const token = this.detectToken;
      if (!this.aiTranslateEnabled) {
        this.detecting = false;
        this.resolution = null;
        this.managedStatus = null;
        return;
      }
      if (this.usesManagedModel) {
        const app = electron.remote.app;
        const runtimeDir = app.isPackaged
          ? `${process.resourcesPath}/llama`
          : `${app.getAppPath()}/build/llama`;
        this.managedStatus = inspectManagedModel({
          serverPath: `${runtimeDir}/llama-server`,
          modelDir: `${app.getPath('userData')}/qwen3`,
        });
        this.resolution = null;
        this.detecting = false;
        return;
      }
      this.managedStatus = null;
      this.detecting = true;
      resolveAIProvider({
        aiTranslateProvider: this.$store.getters.aiTranslateProvider,
        aiTranslateApiUrl: this.$store.getters.aiTranslateApiUrl,
        aiTranslateApiKey: this.$store.getters.aiTranslateApiKey,
        aiTranslateModel: this.$store.getters.aiTranslateModel,
      }).then((resolution) => {
        if (token !== this.detectToken) return;
        this.resolution = resolution;
      }).catch(() => {
        if (token !== this.detectToken) return;
        this.resolution = null;
      }).then(() => {
        if (token !== this.detectToken) return;
        this.detecting = false;
      });
    },
    persistAI(partial) {
      this.$store.dispatch('setPreference', partial).then(() => {
        electron.ipcRenderer.send('preference-to-main', this.preferenceData);
      });
    },
    handleFirstSelection(selection) {
      if (selection === this.secondaryLanguage) this.secondaryLanguage = '';
      this.primaryLanguage = selection;
      this.showFirstSelection = false;
    },
    handleSecondSelection(selection) {
      if (selection !== this.primaryLanguage) {
        this.secondaryLanguage = selection;
        this.showSecondSelection = false;
      }
    },
    openFirstDropdown() {
      if (this.privacyAgreement) {
        if (this.showFirstSelection) {
          this.showFirstSelection = false;
        } else {
          this.showFirstSelection = true;
          this.showSecondSelection = false;
        }
      }
    },
    openSecondDropdown() {
      if (this.privacyAgreement) {
        if (this.showSecondSelection) {
          this.showSecondSelection = false;
        } else {
          this.showSecondSelection = true;
          this.showFirstSelection = false;
        }
      }
    },
  },
};
</script>
<style scoped lang="scss">
.privicy {
  .checkbox:nth-of-type(1) {
    margin-top: 0;
  }
  .quick_edit {
    margin-top: 30px;
  }
  .aiTranslate {
    margin-top: 30px;
    &__table {
      width: 100%;
    }
    &__label {
      font-family: $font-medium;
      font-size: 13px;
      color: rgba(255, 255, 255, 0.7);
      white-space: nowrap;
      padding-right: 14px;
      width: 96px;
    }
    &__status {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.4);
      line-height: 1.4;
    }
    &__redetect {
      flex-shrink: 0;
      margin-left: 10px;
      cursor: pointer;
      background-color: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 3px;
      color: rgba(255, 255, 255, 0.7);
      font-size: 11px;
      padding: 3px 8px;
      outline: none;
      &:hover {
        background-color: rgba(255, 255, 255, 0.12);
      }
      &:disabled {
        cursor: not-allowed;
        opacity: 0.4;
      }
    }
    &__input {
      width: 100%;
      box-sizing: border-box;
      background-color: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      color: rgba(255, 255, 255, 0.8);
      font-size: 12px;
      padding: 6px 10px;
      outline: none;
      transition: border-color 200ms;
      &:focus {
        border-color: rgba(255, 255, 255, 0.3);
      }
      &:disabled {
        cursor: not-allowed;
      }
      option {
        color: #000;
      }
    }
  }
}
.tabcontent {
  .settingItem {
    &__attached {
      background-color: rgba(0,0,0,0.07);
      margin-top: 15px;
      padding: 20px 28px;
      border-radius: 5px;
      position: relative;
      z-index: 1;
      table {
        width: 100%;
        tr {
          height: 40px;
        }
      }
    }

    &__title {
      font-family: $font-medium;
      font-size: 14px;
      color: rgba(255,255,255,0.7);
    }

    &__description {
      font-family: $font-medium;
      font-size: 12px;
      color: rgba(255,255,255,0.25);
      margin-top: 7px;
      margin-bottom: 7px;
    }

    &__input {
      -webkit-app-region: no-drag;
      cursor: pointer;
      font-family: $font-semibold;
      font-size: 11px;
      color: rgba(255,255,255,.7);
      text-align: center;
      border-radius: 2px;
      border: 1px solid rgba(255,255,255,0.1);
      background-color: rgba(255,255,255,0.03);
      transition: all 200ms;

      &:hover {
        border: 1px solid rgba(255,255,255,0.2);
        background-color: rgba(255,255,255,0.08);
      }
    }

    tr:nth-of-type(1) .dropdown {
      z-index: 1;
    }
  }
  .dropdown {
    position: relative;
    width: 240px;
    height: 28px;

    &__title {
      height: 28px;
      text-overflow: ellipsis;
      white-space: nowrap;
      width: 10%;
      padding-right: 10px;
      line-height: 28px;
      font-family: $font-medium;
      font-size: 12px;
      color: rgba(255,255,255,0.7);
    }

    &__toggle {
      position: absolute;
      top: 0;
      width: 100%;
      margin-top: -1px;
      margin-left: -1px;
      transition: all 200ms;
      border-radius: 2px;
      overflow: hidden;
      -webkit-app-region: no-drag;

      &--display {
        @extend .dropdown__toggle;
        height: 28px;
        border: 1px solid rgba(255,255,255,0);
        background-color: rgba(255, 255, 255, 0);
      }

      &--list {
        @extend .dropdown__toggle;
        height: 148px;
        border: 1px solid rgba(255,255,255,0.3);
        background-color: #4B4B50;
        .dropdown__displayItem {
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
      }
    }

    &__displayItem {
      height: 28px;
      line-height: 28px;
      border-bottom: 1px solid rgba(255,255,255,0);
    }

    &__listItems {
      cursor: pointer;
      position: relative;
      height: 112px;
      margin: 4px 4px 4px 6px;
      overflow-y: scroll;
    }

    .dropdownListItem {
      height: 28px;
      line-height: 28px;

      &:hover {
        background-image: linear-gradient(
          90deg,
          rgba(255,255,255,0.00) 0%,
          rgba(255,255,255,0.069) 23%,
          rgba(255,255,255,0.00) 100%,
        );
      }
    }

    &__icon {
      position: absolute;
      top: 7px;
      right: 8px;
      transition: transform 200ms;
      &--arrowDown {
        @extend .dropdown__icon;
        transform: rotate(90deg);
      }
      &--arrowUp {
        @extend .dropdown__icon;
        z-index: 100;
        transform: rotate(-90deg);
      }
    }

    ::-webkit-scrollbar {
      width: 3px;
      user-select: none;
    }
    /* Handle */
    ::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.1);
      border-radius: 1.5px;
    }
    ::-webkit-scrollbar-track {
      cursor: pointer;
      border-radius: 2px;
      width: 10px;
      user-select: none;
    }
  }
}
</style>
