package org.splayer.tv.network;

import android.os.Handler;
import android.os.Looper;

import org.splayer.tv.model.NetworkEntry;
import org.splayer.tv.model.NetworkLocation;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class NetworkBrowser {
    public interface Callback {
        void onSuccess(List<NetworkEntry> entries);

        void onError(Throwable error);
    }

    private static final long CACHE_DURATION_MS = 30_000;
    private static final int MAX_CACHE_ENTRIES = 16;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private final Map<String, CacheValue> cache = new LinkedHashMap<>(
            MAX_CACHE_ENTRIES,
            0.75f,
            true
    ) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, CacheValue> eldest) {
            return size() > MAX_CACHE_ENTRIES;
        }
    };
    private final Map<String, List<Callback>> pending = new LinkedHashMap<>();

    public void browse(
            NetworkLocation location,
            String uri,
            boolean forceRefresh,
            Callback callback
    ) {
        String key = location.cacheKey(uri);
        synchronized (this) {
            CacheValue cached = cache.get(key);
            if (!forceRefresh && cached != null && !cached.isExpired()) {
                List<NetworkEntry> snapshot = new ArrayList<>(cached.entries);
                mainHandler.post(() -> callback.onSuccess(snapshot));
                return;
            }
            List<Callback> callbacks = pending.get(key);
            if (callbacks != null) {
                callbacks.add(callback);
                return;
            }
            callbacks = new ArrayList<>();
            callbacks.add(callback);
            pending.put(key, callbacks);
        }

        executor.execute(() -> {
            try {
                List<NetworkEntry> entries;
                if ("smb".equals(location.getScheme())) {
                    entries = SmbClient.list(location, uri);
                } else {
                    entries = WebDavClient.list(location, uri);
                }
                complete(key, entries, null);
            } catch (Throwable error) {
                complete(key, null, error);
            }
        });
    }

    private void complete(String key, List<NetworkEntry> entries, Throwable error) {
        List<Callback> callbacks;
        synchronized (this) {
            callbacks = pending.remove(key);
            if (error == null && entries != null) {
                cache.put(key, new CacheValue(entries));
            }
        }
        if (callbacks == null) return;
        List<NetworkEntry> snapshot = entries == null ? null : new ArrayList<>(entries);
        mainHandler.post(() -> {
            for (Callback callback : callbacks) {
                if (error == null) callback.onSuccess(new ArrayList<>(snapshot));
                else callback.onError(error);
            }
        });
    }

    public synchronized void clear() {
        cache.clear();
    }

    public void shutdown() {
        executor.shutdownNow();
    }

    private static final class CacheValue {
        private final List<NetworkEntry> entries;
        private final long createdAt = System.currentTimeMillis();

        private CacheValue(List<NetworkEntry> entries) {
            this.entries = new ArrayList<>(entries);
        }

        private boolean isExpired() {
            return System.currentTimeMillis() - createdAt > CACHE_DURATION_MS;
        }
    }
}
