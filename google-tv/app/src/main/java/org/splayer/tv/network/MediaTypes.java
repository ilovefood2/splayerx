package org.splayer.tv.network;

import java.net.URI;
import java.util.Locale;
import java.util.Set;

public final class MediaTypes {
    private static final Set<String> VIDEO_EXTENSIONS = Set.of(
            "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov",
            "mp4", "mpeg", "mpg", "mts", "ogv", "ts", "webm", "wmv"
    );

    private MediaTypes() {
    }

    public static boolean isPlayable(String uri) {
        String path;
        try {
            path = URI.create(uri).getPath();
        } catch (IllegalArgumentException error) {
            path = uri;
        }
        if (path == null) return false;
        int queryIndex = path.indexOf('?');
        if (queryIndex >= 0) path = path.substring(0, queryIndex);
        int extensionIndex = path.lastIndexOf('.');
        if (extensionIndex < 0 || extensionIndex == path.length() - 1) return false;
        return VIDEO_EXTENSIONS.contains(
                path.substring(extensionIndex + 1).toLowerCase(Locale.US)
        );
    }
}
