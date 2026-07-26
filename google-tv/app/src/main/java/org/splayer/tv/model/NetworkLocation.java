package org.splayer.tv.model;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;

public final class NetworkLocation {
    private String id;
    private String name;
    private String address;
    private String username;
    private String password;

    public NetworkLocation(
            String id,
            String name,
            String address,
            String username,
            String password
    ) {
        this.id = id;
        this.name = name;
        this.address = address;
        this.username = username;
        this.password = password;
    }

    public static NetworkLocation create(
            String name,
            String address,
            String username,
            String password
    ) {
        String normalized = normalizeAddress(address);
        String finalName = name == null || name.trim().isEmpty()
                ? hostName(normalized)
                : name.trim();
        return new NetworkLocation(
                UUID.randomUUID().toString(),
                finalName,
                normalized,
                safe(username),
                safe(password)
        );
    }

    public static String normalizeAddress(String value) {
        String address = safe(value).trim();
        if (!address.contains("://")) {
            address = "smb://" + address;
        }
        try {
            URI uri = new URI(address);
            String scheme = uri.getScheme() == null
                    ? ""
                    : uri.getScheme().toLowerCase(Locale.US);
            if (!scheme.equals("smb") && !scheme.equals("http") && !scheme.equals("https")) {
                throw new IllegalArgumentException("Unsupported network protocol");
            }
            if (uri.getHost() == null || uri.getHost().isEmpty()) {
                throw new IllegalArgumentException("Network address requires a host");
            }
            return uri.normalize().toString();
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Invalid network address", error);
        }
    }

    private static String hostName(String address) {
        try {
            URI uri = new URI(address);
            return uri.getHost() == null ? address : uri.getHost();
        } catch (URISyntaxException ignored) {
            return address;
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    public String getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public String getAddress() {
        return address;
    }

    public String getUsername() {
        return username;
    }

    public String getPassword() {
        return password;
    }

    public String getScheme() {
        return URI.create(address).getScheme().toLowerCase(Locale.US);
    }

    public String cacheKey(String uri) {
        return id + "\n" + uri;
    }

    @Override
    public boolean equals(Object value) {
        if (this == value) return true;
        if (!(value instanceof NetworkLocation)) return false;
        NetworkLocation other = (NetworkLocation) value;
        return Objects.equals(id, other.id);
    }

    @Override
    public int hashCode() {
        return Objects.hash(id);
    }
}
