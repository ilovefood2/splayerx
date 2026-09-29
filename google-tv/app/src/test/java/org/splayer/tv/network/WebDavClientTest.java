package org.splayer.tv.network;

import org.junit.Test;
import org.splayer.tv.model.NetworkEntry;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class WebDavClientTest {
    @Test
    public void parsesFoldersAndPlayableFilesFromOnePropfindResponse() throws Exception {
        String xml = "<?xml version=\"1.0\"?>"
                + "<d:multistatus xmlns:d=\"DAV:\">"
                + "<d:response><d:href>/dav/</d:href>"
                + "<d:propstat><d:prop><d:resourcetype><d:collection/>"
                + "</d:resourcetype></d:prop></d:propstat></d:response>"
                + "<d:response><d:href>/dav/Season%201/</d:href>"
                + "<d:propstat><d:prop><d:displayname>Season 1</d:displayname>"
                + "<d:resourcetype><d:collection/></d:resourcetype>"
                + "</d:prop></d:propstat></d:response>"
                + "<d:response><d:href>/dav/Episode%201.mkv</d:href>"
                + "<d:propstat><d:prop><d:displayname>Episode 1.mkv</d:displayname>"
                + "<d:resourcetype/></d:prop></d:propstat></d:response>"
                + "<d:response><d:href>/dav/notes.txt</d:href>"
                + "<d:propstat><d:prop><d:resourcetype/></d:prop>"
                + "</d:propstat></d:response></d:multistatus>";

        List<NetworkEntry> entries = WebDavClient.parseListing(
                "https://nas.local/dav/",
                new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8))
        );

        assertEquals(2, entries.size());
        assertTrue(entries.get(0).isDirectory());
        assertEquals("Season 1", entries.get(0).getName());
        assertEquals("Episode 1.mkv", entries.get(1).getName());
    }

    @Test
    public void namesFilesFromTheirHrefWhenTheServerSendsNoDisplayName() throws Exception {
        // Apache and nginx WebDAV omit displayname, so the name comes from the
        // (percent-encoded) href and must be decoded exactly once.
        String xml = "<?xml version=\"1.0\"?>"
                + "<d:multistatus xmlns:d=\"DAV:\">"
                + "<d:response><d:href>/dav/100%25%20Real.mp4</d:href>"
                + "<d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>"
                + "<d:response><d:href>/dav/A+B.mkv</d:href>"
                + "<d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>"
                + "<d:response><d:href>/dav/Caf%C3%A9/</d:href>"
                + "<d:propstat><d:prop><d:resourcetype><d:collection/>"
                + "</d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>";

        List<NetworkEntry> entries = WebDavClient.parseListing(
                "https://nas.local/dav/",
                new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8))
        );

        assertEquals(3, entries.size());
        assertEquals("Café", entries.get(0).getName());
        assertEquals("100% Real.mp4", entries.get(1).getName());
        assertEquals("A+B.mkv", entries.get(2).getName());
    }
}
