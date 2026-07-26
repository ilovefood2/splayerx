package org.splayer.tv.model;

public final class NetworkEntry {
    private final String name;
    private final String uri;
    private final boolean directory;

    public NetworkEntry(String name, String uri, boolean directory) {
        this.name = name;
        this.uri = uri;
        this.directory = directory;
    }

    public String getName() {
        return name;
    }

    public String getUri() {
        return uri;
    }

    public boolean isDirectory() {
        return directory;
    }
}
