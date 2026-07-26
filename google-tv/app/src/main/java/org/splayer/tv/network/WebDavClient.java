package org.splayer.tv.network;

import okhttp3.Credentials;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import org.splayer.tv.model.NetworkEntry;
import org.splayer.tv.model.NetworkLocation;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import java.io.InputStream;
import java.net.URI;
import java.net.URLDecoder;
import java.io.UnsupportedEncodingException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.TimeUnit;

import javax.xml.parsers.DocumentBuilderFactory;

public final class WebDavClient {
    private static final MediaType XML = MediaType.get("application/xml; charset=utf-8");
    private static final String PROPFIND = "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
            + "<d:propfind xmlns:d=\"DAV:\"><d:prop><d:displayname/>"
            + "<d:resourcetype/></d:prop></d:propfind>";
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(18, TimeUnit.SECONDS)
            .build();

    private WebDavClient() {
    }

    public static List<NetworkEntry> list(NetworkLocation location, String uri) throws Exception {
        String directoryUri = uri.endsWith("/") ? uri : uri + "/";
        Request.Builder request = new Request.Builder()
                .url(directoryUri)
                .header("Depth", "1")
                .method("PROPFIND", RequestBody.create(PROPFIND, XML));
        if (!location.getUsername().isEmpty() || !location.getPassword().isEmpty()) {
            request.header("Authorization", Credentials.basic(
                    location.getUsername(),
                    location.getPassword(),
                    StandardCharsets.UTF_8
            ));
        }

        try (Response response = CLIENT.newCall(request.build()).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                throw new IllegalStateException("WebDAV returned HTTP " + response.code());
            }
            try (InputStream input = response.body().byteStream()) {
                return parseListing(directoryUri, input);
            }
        }
    }

    static List<NetworkEntry> parseListing(String directoryUri, InputStream input) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        Document document = factory.newDocumentBuilder().parse(input);
        NodeList responses = document.getElementsByTagNameNS("*", "response");
        URI base = URI.create(directoryUri);
        String basePath = ensureTrailingSlash(base.getPath());
        List<NetworkEntry> entries = new ArrayList<>();

        for (int index = 0; index < responses.getLength(); index += 1) {
            Element response = (Element) responses.item(index);
            String href = firstText(response, "href");
            if (href.isEmpty()) continue;
            URI resolved = base.resolve(href);
            String resolvedPath = resolved.getPath();
            if (ensureTrailingSlash(resolvedPath).equals(basePath)) continue;
            boolean directory = response.getElementsByTagNameNS("*", "collection").getLength() > 0;
            String name = firstText(response, "displayname");
            if (name.isEmpty()) name = nameFromPath(resolvedPath);
            if (directory || MediaTypes.isPlayable(resolved.toString())) {
                entries.add(new NetworkEntry(name, resolved.toString(), directory));
            }
        }
        entries.sort(Comparator
                .comparing(NetworkEntry::isDirectory).reversed()
                .thenComparing(NetworkEntry::getName, String.CASE_INSENSITIVE_ORDER));
        return entries;
    }

    private static String firstText(Element element, String localName) {
        NodeList nodes = element.getElementsByTagNameNS("*", localName);
        if (nodes.getLength() == 0) return "";
        Node node = nodes.item(0);
        return node == null || node.getTextContent() == null ? "" : node.getTextContent().trim();
    }

    private static String ensureTrailingSlash(String value) {
        if (value == null || value.isEmpty()) return "/";
        return value.endsWith("/") ? value : value + "/";
    }

    private static String nameFromPath(String path) {
        String value = path == null ? "" : path;
        while (value.endsWith("/") && value.length() > 1) {
            value = value.substring(0, value.length() - 1);
        }
        int slash = value.lastIndexOf('/');
        String name = slash >= 0 ? value.substring(slash + 1) : value;
        try {
            return URLDecoder.decode(name, StandardCharsets.UTF_8.name());
        } catch (UnsupportedEncodingException impossible) {
            return name;
        }
    }
}
