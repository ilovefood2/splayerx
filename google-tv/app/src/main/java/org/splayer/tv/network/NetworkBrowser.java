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

    public interface DeleteCallback {
        void onComplete(RemoteFiles.DeleteResult result);
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
    private volatile boolean closed;

    public void browse(
            NetworkLocation location,
            String uri,
            boolean forceRefresh,
            Callback callback
    ) {
        String key = location.cacheKey(uri);
        final List<Callback> request;
        synchronized (this) {
            if (closed) return;
            if (forceRefresh) {
                cache.remove(key);
                pending.remove(key);
            }
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
            request = new ArrayList<>();
            request.add(callback);
            pending.put(key, request);
        }

        executor.execute(() -> {
            try {
                List<NetworkEntry> entries;
                if ("smb".equals(location.getScheme())) {
                    entries = SmbClient.list(location, uri);
                } else {
                    entries = WebDavClient.list(location, uri);
                }
                complete(key, request, entries, null);
            } catch (Exception error) {
                complete(key, request, null, error);
            }
        });
    }

    private void complete(String key, List<Callback> request, List<NetworkEntry> entries, Throwable error) {
        List<Callback> callbacks;
        synchronized (this) {
            if (closed || pending.get(key) != request) return;
            callbacks = pending.remove(key);
            if (error == null && entries != null) {
                cache.put(key, new CacheValue(entries));
            }
        }
        if (callbacks == null) return;
        List<NetworkEntry> snapshot = entries == null ? null : new ArrayList<>(entries);
        mainHandler.post(() -> {
            if (closed) return;
            for (Callback callback : callbacks) {
                if (error == null) callback.onSuccess(new ArrayList<>(snapshot));
                else callback.onError(error);
            }
        });
    }

    public synchronized void clear() {
        cache.clear();
        pending.clear();
    }

    public void deleteFiles(NetworkLocation location, List<NetworkEntry> entries, DeleteCallback callback) {
        List<NetworkEntry> snapshot = new ArrayList<>(entries);
        if (snapshot.isEmpty()) throw new IllegalArgumentException("No files selected");
        // Validate before scheduling, so an unsafe batch cannot partially delete files.
        for (NetworkEntry entry : snapshot) RemoteFiles.requireSafeFile(location, entry);
        clear();
        executor.execute(() -> {
            RemoteFiles.DeleteResult result = RemoteFiles.deleteAll(location, snapshot);
            clear();
            mainHandler.post(() -> {
                if (!closed) callback.onComplete(result);
            });
        });
    }

    public void shutdown() {
        closed = true;
        clear();
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
