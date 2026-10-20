package org.splayer.tv.network;

import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.splayer.tv.model.NetworkEntry;
import org.splayer.tv.model.NetworkLocation;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.Assert.*;

public class RemoteFilesTest {
    private MockWebServer server;
    private String root;
    private final List<String> requests = new CopyOnWriteArrayList<>();

    @Before public void startServer() throws Exception {
        server = new MockWebServer();
        server.start();
        root = server.url("/library/").toString();
        server.setDispatcher(new Dispatcher() {
            @Override public MockResponse dispatch(RecordedRequest request) {
                String path = request.getPath();
                requests.add(request.getMethod() + " " + path);
                int code = path.endsWith("denied.mp4") ? 403
                        : path.endsWith("missing.mp4") ? 404
                        : path.endsWith("pending.mp4") ? 202
                        : path.endsWith("multi.mp4") ? 207 : 204;
                if (path.endsWith("auth.mp4")) {
                    String want = "Basic " + Base64.getEncoder().encodeToString(
                            "test-user:test-password".getBytes(StandardCharsets.UTF_8));
                    if (!want.equals(request.getHeader("Authorization"))) code = 401;
                }
                if (path.endsWith("redirect.mp4")) {
                    return new MockResponse().setResponseCode(302).setHeader("Location", root + "redirected.mp4");
                }
                return new MockResponse().setResponseCode(code);
            }
        });
    }

    @After public void stopServer() throws Exception { server.shutdown(); }

    private NetworkLocation location() {
        return NetworkLocation.create("Test", root, "test-user", "test-password");
    }

    private NetworkEntry file(String name) { return new NetworkEntry(name, root + name, false); }

    @Test public void batchKeepsFailuresAndDeletesEachFileOnlyOnce() {
        NetworkEntry good = file("auth.mp4");
        NetworkEntry denied = file("denied.mp4");
        RemoteFiles.DeleteResult result = RemoteFiles.deleteAll(location(), Arrays.asList(good, denied, good));
        assertEquals(Collections.singletonList(good), result.deleted);
        assertEquals(Collections.singletonList(denied), result.failed);
        assertEquals(Arrays.asList("DELETE /library/auth.mp4", "DELETE /library/denied.mp4"), requests);
    }

    @Test public void unsafeBatchIsRejectedBeforeDeletingItsFirstValidFile() {
        List<NetworkEntry> batch = Arrays.asList(file("good.mp4"),
                new NetworkEntry("Folder", root + "Folder/", true));
        assertThrows(IllegalArgumentException.class, () -> RemoteFiles.deleteAll(location(), batch));
        assertTrue(requests.isEmpty());
    }

    @Test public void refusesDirectoriesShareRootsTraversalAndForeignServers() {
        NetworkLocation smb = NetworkLocation.create("Router", "smb://router/Videos/", "", "");
        String[] rejected = {"smb://router/Videos/", "smb://router/Other/file.mp4",
                "smb://other/Videos/file.mp4", "smb://router/Videos/../file.mp4",
                "smb://router/Videos/%2e%2e/file.mp4", "smb://router/Videos/a%2fb.mp4",
                "smb://router/Videos/file.mp4?x=1", "smb://user@router/Videos/file.mp4",
                "smb://router:444/Videos/file.mp4", "https://router/Videos/file.mp4"};
        for (String uri : rejected) assertFalse(uri, RemoteFiles.canDelete(smb, new NetworkEntry("file", uri, false)));
        assertFalse(RemoteFiles.canDelete(smb, new NetworkEntry("Folder", "smb://router/Videos/Folder.mp4/", true)));
        assertTrue(RemoteFiles.canDelete(smb, new NetworkEntry("name", "smb://router/Videos/Season%201/100%25+A.mp4", false)));
        assertFalse(RemoteFiles.canDelete(NetworkLocation.create("Share", "smb://router/Share.mp4", "", ""),
                new NetworkEntry("Share", "smb://router/Share.mp4", false)));
    }

    @Test public void directVideoLocationOnlyAllowsThatExactVideo() {
        NetworkLocation direct = NetworkLocation.create("Video", root + "one.mp4", "", "");
        assertTrue(RemoteFiles.canDelete(direct, file("one.mp4")));
        assertFalse(RemoteFiles.canDelete(direct, file("two.mp4")));
    }

    @Test public void supportsRawSpacesAndLiteralPercentFromSmbListings() {
        NetworkLocation smb = NetworkLocation.create("Router", "smb://router/Videos/", "", "");
        assertTrue(RemoteFiles.canDelete(smb,
                new NetworkEntry("spaces + 100%.mp4", "smb://router/Videos/spaces + 100%.mp4", false)));
    }

    @Test public void doesNotFollowDeleteRedirectsOrTreatAsyncAndMultiStatusAsSuccess() {
        RemoteFiles.DeleteResult result = RemoteFiles.deleteAll(location(),
                Arrays.asList(file("redirect.mp4"), file("pending.mp4"), file("multi.mp4")));
        assertTrue(result.deleted.isEmpty());
        assertEquals(3, result.failed.size());
        assertEquals(3, requests.size());
        assertFalse(requests.toString().contains("redirected.mp4"));
    }

    @Test public void alreadyAbsentFileIsNotLeftSelectedForRetry() {
        RemoteFiles.DeleteResult result = RemoteFiles.deleteAll(location(), Collections.singletonList(file("missing.mp4")));
        assertEquals(1, result.deleted.size());
        assertTrue(result.failed.isEmpty());
    }

    @Test public void emptyBatchCannotScheduleAnOperation() {
        assertThrows(IllegalArgumentException.class, () -> RemoteFiles.deleteAll(location(), new ArrayList<>()));
        assertTrue(requests.isEmpty());
    }
}
