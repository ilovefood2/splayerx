package org.splayer.tv.network;

import org.splayer.tv.model.NetworkEntry;
import org.splayer.tv.model.NetworkLocation;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Properties;

import jcifs.CIFSContext;
import jcifs.config.PropertyConfiguration;
import jcifs.context.BaseContext;
import jcifs.smb.NtlmPasswordAuthenticator;
import jcifs.smb.SmbFile;

public final class SmbClient {
    private SmbClient() {
    }

    public static CIFSContext context(NetworkLocation location) throws Exception {
        Properties properties = new Properties();
        properties.setProperty("jcifs.smb.client.enableSMB2", "true");
        properties.setProperty("jcifs.smb.client.disableSMB1", "false");
        properties.setProperty("jcifs.smb.client.responseTimeout", "12000");
        properties.setProperty("jcifs.smb.client.soTimeout", "18000");
        CIFSContext context = new BaseContext(new PropertyConfiguration(properties));
        if (!location.getUsername().isEmpty() || !location.getPassword().isEmpty()) {
            context = context.withCredentials(new NtlmPasswordAuthenticator(
                    null,
                    location.getUsername(),
                    location.getPassword()
            ));
        }
        return context;
    }

    public static List<NetworkEntry> list(NetworkLocation location, String uri) throws Exception {
        CIFSContext context = context(location);
        String directoryUri = uri.endsWith("/") ? uri : uri + "/";
        List<NetworkEntry> entries = new ArrayList<>();
        try (SmbFile directory = new SmbFile(directoryUri, context)) {
            SmbFile[] files = directory.listFiles();
            if (files == null) return entries;
            for (SmbFile file : files) {
                try (file) {
                    boolean folder = file.isDirectory();
                    if (folder || MediaTypes.isPlayable(file.getPath())) {
                        entries.add(new NetworkEntry(
                                trimTrailingSlash(file.getName()),
                                file.getPath(),
                                folder
                        ));
                    }
                }
            }
        }
        entries.sort(Comparator
                .comparing(NetworkEntry::isDirectory).reversed()
                .thenComparing(NetworkEntry::getName, String.CASE_INSENSITIVE_ORDER));
        return entries;
    }

    private static String trimTrailingSlash(String value) {
        if (value == null) return "";
        while (value.endsWith("/") && value.length() > 1) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }
}
