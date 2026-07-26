package org.splayer.tv.network;

import android.media.MediaDataSource;

import org.splayer.tv.model.NetworkLocation;

import java.io.IOException;

import jcifs.CIFSContext;
import jcifs.smb.SmbFile;
import jcifs.smb.SmbRandomAccessFile;

public final class SmbMediaDataSource extends MediaDataSource {
    private final SmbFile file;
    private final SmbRandomAccessFile input;
    private final long size;

    public SmbMediaDataSource(NetworkLocation location, String uri) throws Exception {
        CIFSContext context = SmbClient.context(location);
        file = new SmbFile(uri, context);
        input = new SmbRandomAccessFile(file, "r");
        size = input.length();
    }

    @Override
    public synchronized int readAt(long position, byte[] buffer, int offset, int size)
            throws IOException {
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
        input.close();
        file.close();
    }
}
