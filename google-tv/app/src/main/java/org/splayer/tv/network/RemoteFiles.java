package org.splayer.tv.network;

import org.splayer.tv.model.NetworkEntry;
import org.splayer.tv.model.NetworkLocation;
import jcifs.CIFSContext;

import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public final class RemoteFiles {
    private RemoteFiles() { }

    public static final class DeleteResult {
        public final List<NetworkEntry> deleted = new ArrayList<>();
        public final List<NetworkEntry> failed = new ArrayList<>();
    }

    public static boolean canDelete(NetworkLocation location, NetworkEntry entry) {
        try {
            requireSafeFile(location, entry);
            return true;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    public static DeleteResult deleteAll(NetworkLocation location, List<NetworkEntry> entries) {
        if (entries.isEmpty()) throw new IllegalArgumentException("No files selected");
        Map<String, NetworkEntry> unique = new LinkedHashMap<>();
        // Validate the entire selection before making any destructive request.
        for (NetworkEntry entry : entries) {
            requireSafeFile(location, entry);
            unique.put(entry.getUri(), entry);
        }
        DeleteResult result = new DeleteResult();
        CIFSContext context = null;
        try {
            if ("smb".equals(location.getScheme())) context = SmbClient.context(location);
            for (NetworkEntry entry : unique.values()) {
                try {
                    if (context != null) SmbClient.deleteFile(context, entry.getUri());
                    else WebDavClient.deleteFile(location, entry.getUri());
                    result.deleted.add(entry);
                } catch (Exception error) {
                    result.failed.add(entry);
                }
            }
        } catch (Exception error) {
            result.failed.addAll(unique.values());
        } finally {
            if (context != null) try { context.close(); } catch (Exception ignored) { }
        }
        return result;
    }

    static void requireSafeFile(NetworkLocation location, NetworkEntry entry) {
        if (location == null || entry == null || entry.getUri() == null
                || entry.isDirectory() || !MediaTypes.isPlayable(entry.getUri())) {
            throw new IllegalArgumentException("Only video files can be deleted");
        }
        URI base = safeUri(location.getAddress());
        URI file = safeUri(entry.getUri());
        String root = base.getPath().isEmpty() ? "/" : base.getPath();
        String path = file.getPath();
        if (!sameServer(base, file) || path.endsWith("/")) {
            throw new IllegalArgumentException("File is outside this network location");
        }
        boolean directVideo = MediaTypes.isPlayable(base.toString()) && !root.endsWith("/");
        if (directVideo ? !path.equals(root) : !path.startsWith(trailingSlash(root))) {
            throw new IllegalArgumentException("File is outside this network location");
        }
        if ("smb".equalsIgnoreCase(file.getScheme()) && path.substring(1).split("/").length < 2) {
            throw new IllegalArgumentException("An SMB share cannot be deleted");
        }
    }

    static boolean isDirectChild(String directory, String candidate) {
        try {
            URI base = safeUri(directory);
            URI child = safeUri(candidate);
            String root = trailingSlash(base.getPath());
            String path = child.getPath();
            if (!sameServer(base, child) || !path.startsWith(root)) return false;
            String relative = path.substring(root.length());
            if (relative.endsWith("/")) relative = relative.substring(0, relative.length() - 1);
            return !relative.isEmpty() && !relative.contains("/");
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static URI safeUri(String address) {
        if (address == null) throw new IllegalArgumentException("Missing file address");
        // SMB listings can contain unescaped spaces and literal percent signs.
        URI uri = URI.create(address.replace(" ", "%20").replaceAll("%(?![0-9a-fA-F]{2})", "%25"));
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("smb")
                || scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))
                || uri.getHost() == null || uri.getUserInfo() != null
                || uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("Unsupported file address");
        }
        String path = uri.getPath();
        String raw = uri.getRawPath().toLowerCase(Locale.ROOT);
        if (path.contains("\\") || path.indexOf('\0') >= 0
                || raw.contains("%2f") || raw.contains("%5c")) {
            throw new IllegalArgumentException("Invalid file path");
        }
        for (String part : path.split("/")) {
            if (part.equals(".") || part.equals("..")) {
                throw new IllegalArgumentException("Invalid file path");
            }
        }
        return uri;
    }

    private static boolean sameServer(URI first, URI second) {
        return first.getScheme().equalsIgnoreCase(second.getScheme())
                && first.getHost().equalsIgnoreCase(second.getHost())
                && port(first) == port(second);
    }

    private static int port(URI uri) {
        if (uri.getPort() != -1) return uri.getPort();
        if (uri.getScheme().equalsIgnoreCase("https")) return 443;
        return uri.getScheme().equalsIgnoreCase("smb") ? 445 : 80;
    }

    private static String trailingSlash(String path) {
        return path.endsWith("/") ? path : path + "/";
    }
}
