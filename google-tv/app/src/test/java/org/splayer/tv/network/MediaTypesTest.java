package org.splayer.tv.network;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class MediaTypesTest {
    @Test
    public void recognizesNetworkVideoPathsCaseInsensitively() {
        assertTrue(MediaTypes.isPlayable("smb://nas/Shows/Episode.MKV"));
        assertTrue(MediaTypes.isPlayable("https://nas/movie.mp4?token=one"));
        assertFalse(MediaTypes.isPlayable("https://nas/Shows/"));
        assertFalse(MediaTypes.isPlayable("https://nas/readme.txt"));
    }
}
