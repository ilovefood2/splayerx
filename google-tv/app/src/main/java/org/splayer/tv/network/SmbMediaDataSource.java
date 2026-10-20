package org.splayer.tv.network;

import android.media.MediaDataSource;

import org.splayer.tv.model.NetworkLocation;

import java.io.IOException;

import jcifs.CIFSContext;
import jcifs.smb.SmbFile;
import jcifs.smb.SmbRandomAccessFile;

public final class SmbMediaDataSource extends MediaDataSource {
    private final SmbFile file;
    private final CIFSContext context;
    private final SmbRandomAccessFile input;
    private final long size;
    private boolean closed;

    public SmbMediaDataSource(NetworkLocation location, String uri) throws Exception {
        context = SmbClient.context(location);
        file = new SmbFile(uri, context);
        SmbRandomAccessFile opened = null;
        try {
            opened = new SmbRandomAccessFile(file, "r");
            size = opened.length();
            input = opened;
        } catch (Exception error) {
            if (opened != null) try { opened.close(); } catch (IOException ignored) { }
            try { file.close(); } finally { context.close(); }
            throw error;
        }
    }

    @Override
    public synchronized int readAt(long position, byte[] buffer, int offset, int size)
            throws IOException {
        if (closed) throw new IOException("File is closed");
        if (size == 0) return 0;
        if (position >= this.size) return -1;
        input.seek(position);
        return input.read(buffer, offset, (int) Math.min(size, this.size - position));
    }

    @Override
    public long getSize() {
        return size;
    }

    @Override
    public synchronized void close() throws IOException {
        if (closed) return;
        closed = true;
        try { input.close(); } finally {
            try { file.close(); } finally { context.close(); }
        }
    }
}
