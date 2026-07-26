package org.splayer.tv.model;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class NetworkLocationTest {
    @Test
    public void defaultsToSmbAndUsesTheHostAsTheName() {
        NetworkLocation location = NetworkLocation.create(
                "",
                "nas.local/media",
                "",
                ""
        );

        assertEquals("smb://nas.local/media", location.getAddress());
        assertEquals("smb", location.getScheme());
        assertEquals("nas.local", location.getName());
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsUnsupportedProtocols() {
        NetworkLocation.create("Server", "ftp://nas.local/media", "", "");
    }
}
