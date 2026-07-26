<template>
  <section
    class="network-locations"
    :aria-label="$t('browsing.networkLocations.title')"
  >
    <div class="section-heading">
      <h2>{{ $t('browsing.networkLocations.title') }}</h2>
      <button
        type="button"
        class="add-location"
        :disabled="choosingLocation"
        @click="addLocation"
      >
        <span aria-hidden="true">＋</span>
        {{ $t('browsing.networkLocations.add') }}
      </button>
    </div>
    <p
      v-if="!locations.length"
      class="empty-state"
    >
      {{ $t('browsing.networkLocations.empty') }}
    </p>
    <div
      v-else
      class="location-list"
    >
      <article
        v-for="location in locations"
        :key="location.path"
        class="location-card"
      >
        <button
          type="button"
          class="open-location"
          :aria-label="$t('browsing.networkLocations.open', { name: location.name })"
          @click="openLocation(location)"
        >
          <span
            class="location-icon"
            aria-hidden="true"
          >★</span>
          <span class="location-copy">
            <strong>{{ location.name }}</strong>
            <small>{{ location.path }}</small>
          </span>
        </button>
        <button
          type="button"
          class="remove-location"
          :aria-label="$t('browsing.networkLocations.remove', { name: location.name })"
          @click="removeLocation(location.path)"
        >
          ×
        </button>
      </article>
    </div>
    <p
      v-if="statusMessage"
      class="status-message"
      role="status"
    >
      {{ statusMessage }}
    </p>
  </section>
</template>

<script lang="ts">
import path from 'path';
import { promises as fsPromises } from 'fs';
import asyncStorage from '@/helpers/asyncStorage';
import bookmark from '@/helpers/bookmark';
import { log } from '@/libs/Log';

interface NetworkLocation {
  name: string;
  path: string;
}

const STORAGE_KEY = 'network-locations';

export default {
  name: 'NetworkLocations',
  props: {
    onOpen: {
      type: Function,
      required: true,
    },
  },
  data() {
    return {
      choosingLocation: false,
      locations: [] as NetworkLocation[],
      statusMessage: '',
    };
  },
  created() {
    this.loadLocations();
  },
  methods: {
    async loadLocations() {
      try {
        const stored = await asyncStorage.get(STORAGE_KEY);
        this.locations = Array.isArray(stored.locations) ? stored.locations : [];
      } catch (error) {
        log.warn('NetworkLocations.loadLocations', error);
      }
    },
    saveLocations() {
      return asyncStorage.set(STORAGE_KEY, { locations: this.locations });
    },
    async addLocation() {
      this.choosingLocation = true;
      this.statusMessage = '';
      try {
        const defaultPath = process.platform === 'darwin'
          ? '/Volumes'
          : this.$electron.remote.app.getPath('home');
        const result = await this.$electron.remote.dialog.showOpenDialog({
          title: this.$t('browsing.networkLocations.add'),
          defaultPath,
          properties: ['openDirectory'],
          securityScopedBookmarks: process.mas,
        });
        if (result.canceled || !result.filePaths.length) return;

        if (process.mas && result.bookmarks && result.bookmarks.length) {
          bookmark.resolveBookmarks(result.filePaths, result.bookmarks);
        }
        const locationPath = result.filePaths[0];
        const location = {
          name: path.basename(locationPath) || locationPath,
          path: locationPath,
        };
        const existingIndex = this.locations
          .findIndex(item => item.path === location.path);
        if (existingIndex >= 0) {
          this.locations.splice(existingIndex, 1, location);
        } else {
          this.locations.push(location);
        }
        await this.saveLocations();
        await this.openLocation(location);
      } catch (error) {
        log.warn('NetworkLocations.addLocation', error);
        this.statusMessage = this.$t('browsing.networkLocations.unavailable');
      } finally {
        this.choosingLocation = false;
      }
    },
    async openLocation(location: NetworkLocation) {
      this.statusMessage = '';
      try {
        const stats = await fsPromises.stat(location.path);
        if (!stats.isDirectory()) throw new Error('Network location is not a directory');
        await this.onOpen(location.path);
      } catch (error) {
        log.warn('NetworkLocations.openLocation', error);
        this.statusMessage = this.$t('browsing.networkLocations.unavailable');
      }
    },
    async removeLocation(locationPath: string) {
      this.locations = this.locations.filter(location => location.path !== locationPath);
      await this.saveLocations();
    },
  },
};
</script>

<style lang="scss" scoped>
.network-locations {
  position: absolute;
  z-index: 7;
  top: 58px;
  left: 50px;
  right: 50px;
  color: #fff;
  -webkit-user-select: none;
}

.section-heading {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 10px;

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.2px;
  }
}

button {
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
}

.add-location {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.14);
  font-size: 12px;

  &:hover {
    background: rgba(255, 255, 255, 0.24);
  }
}

.empty-state,
.status-message {
  margin: 0;
  color: rgba(255, 255, 255, 0.62);
  font-size: 12px;
}

.location-list {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding: 2px 2px 6px;
}

.location-card {
  position: relative;
  flex: 0 0 210px;
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.08);

  &:hover,
  &:focus-within {
    border-color: rgba(255, 255, 255, 0.62);
    background: rgba(255, 255, 255, 0.14);
  }
}

.open-location {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  padding: 10px 30px 10px 11px;
  background: transparent;
  text-align: left;
}

.location-icon {
  margin-right: 9px;
  color: #f2c94c;
  font-size: 14px;
}

.location-copy {
  min-width: 0;

  strong,
  small {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  strong {
    font-size: 13px;
    font-weight: 600;
  }

  small {
    margin-top: 3px;
    color: rgba(255, 255, 255, 0.55);
    font-size: 10px;
  }
}

.remove-location {
  position: absolute;
  top: 50%;
  right: 7px;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 50%;
  transform: translateY(-50%);
  background: transparent;
  color: rgba(255, 255, 255, 0.56);
  line-height: 18px;

  &:hover {
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
  }
}

.status-message {
  margin-top: 4px;
  color: #ffb4ab;
}
</style>
