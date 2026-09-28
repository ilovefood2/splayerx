package org.splayer.tv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.MediaController;
import android.widget.TextView;

import org.splayer.tv.model.NetworkLocation;
import org.splayer.tv.network.SmbMediaDataSource;
import org.splayer.tv.ui.TvUi;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class PlayerActivity extends Activity
        implements SurfaceHolder.Callback, MediaController.MediaPlayerControl {
    private static final String EXTRA_LOCATION_ID = "location_id";
    private static final String EXTRA_LOCATION_NAME = "location_name";
    private static final String EXTRA_LOCATION_ADDRESS = "location_address";
    private static final String EXTRA_USERNAME = "username";
    private static final String EXTRA_PASSWORD = "password";
    private static final String EXTRA_MEDIA_URI = "media_uri";
    private static final String EXTRA_MEDIA_NAME = "media_name";

    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private SurfaceView surface;
    private TextView status;
    private MediaPlayer player;
    private MediaController controller;
    private SmbMediaDataSource smbDataSource;
    private NetworkLocation location;
    private String mediaUri;
    private boolean preparing;
    private boolean ready;
    private boolean destroyed;

    public static Intent intent(
            Context context,
            NetworkLocation location,
            String mediaUri,
            String mediaName
    ) {
        return new Intent(context, PlayerActivity.class)
                .putExtra(EXTRA_LOCATION_ID, location.getId())
                .putExtra(EXTRA_LOCATION_NAME, location.getName())
                .putExtra(EXTRA_LOCATION_ADDRESS, location.getAddress())
                .putExtra(EXTRA_USERNAME, location.getUsername())
                .putExtra(EXTRA_PASSWORD, location.getPassword())
                .putExtra(EXTRA_MEDIA_URI, mediaUri)
                .putExtra(EXTRA_MEDIA_NAME, mediaName);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );
        Intent intent = getIntent();
        location = new NetworkLocation(
                intent.getStringExtra(EXTRA_LOCATION_ID),
                intent.getStringExtra(EXTRA_LOCATION_NAME),
                intent.getStringExtra(EXTRA_LOCATION_ADDRESS),
                intent.getStringExtra(EXTRA_USERNAME),
                intent.getStringExtra(EXTRA_PASSWORD)
        );
        mediaUri = intent.getStringExtra(EXTRA_MEDIA_URI);
        setContentView(buildContent(intent.getStringExtra(EXTRA_MEDIA_NAME)));
    }

    private View buildContent(String mediaName) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        surface = new SurfaceView(this);
        surface.setKeepScreenOn(true);
        surface.setFocusable(true);
        surface.setFocusableInTouchMode(true);
        surface.getHolder().addCallback(this);
        root.addView(surface, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        status = TvUi.text(
                this,
                getString(R.string.playing, mediaName),
                17,
                Color.WHITE
        );
        status.setBackgroundColor(0x88000000);
        status.setPadding(
                TvUi.dp(this, 24),
                TvUi.dp(this, 12),
                TvUi.dp(this, 24),
                TvUi.dp(this, 12)
        );
        FrameLayout.LayoutParams statusParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
        );
        root.addView(status, statusParams);

        controller = new MediaController(this);
        controller.setMediaPlayer(this);
        controller.setAnchorView(surface);
        surface.requestFocus();
        return root;
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        if (player != null) {
            // Home, the screensaver or ambient mode destroy the surface; the
            // player survives, so bind it to the new one instead of leaving it
            // rendering into a released surface (black video / playback error).
            player.setDisplay(holder);
            return;
        }
        if (preparing) return;
        preparing = true;
        if ("smb".equals(location.getScheme())) {
            status.setText(R.string.loading);
            networkExecutor.execute(() -> {
                try {
                    SmbMediaDataSource source = new SmbMediaDataSource(location, mediaUri);
                    runOnUiThread(() -> {
                        if (destroyed) {
                            try {
                                source.close();
                            } catch (Exception ignored) {
                            }
                            return;
                        }
                        smbDataSource = source;
                        configurePlayer(holder, source);
                    });
                } catch (Throwable error) {
                    runOnUiThread(() -> showPlaybackError(error));
                }
            });
        } else {
            configurePlayer(holder, null);
        }
    }

    private void configurePlayer(SurfaceHolder holder, SmbMediaDataSource source) {
        try {
            player = new MediaPlayer();
            // For SMB this runs after the share opens; the surface may have been
            // destroyed meanwhile. surfaceCreated() attaches it when it returns.
            if (holder.getSurface() != null && holder.getSurface().isValid()) {
                player.setDisplay(holder);
            }
            player.setAudioStreamType(AudioManager.STREAM_MUSIC);
            player.setWakeMode(this, android.os.PowerManager.PARTIAL_WAKE_LOCK);
            player.setOnPreparedListener(mediaPlayer -> {
                preparing = false;
                ready = true;
                status.setVisibility(View.GONE);
                mediaPlayer.start();
                controller.setEnabled(true);
                controller.show(4000);
            });
            player.setOnErrorListener((mediaPlayer, what, extra) -> {
                showPlaybackError(new IllegalStateException(
                        "MediaPlayer error " + what + "/" + extra
                ));
                return true;
            });
            player.setOnCompletionListener(mediaPlayer -> finish());
            if (source != null) {
                player.setDataSource(source);
            } else {
                player.setDataSource(this, Uri.parse(mediaUri), authenticationHeaders());
            }
            player.prepareAsync();
        } catch (Throwable error) {
            showPlaybackError(error);
        }
    }

    private Map<String, String> authenticationHeaders() {
        Map<String, String> headers = new HashMap<>();
        if (!location.getUsername().isEmpty() || !location.getPassword().isEmpty()) {
            String credentials = location.getUsername() + ":" + location.getPassword();
            headers.put(
                    "Authorization",
                    "Basic " + Base64.encodeToString(
                            credentials.getBytes(StandardCharsets.UTF_8),
                            Base64.NO_WRAP
                    )
            );
        }
        return headers;
    }

    private void showPlaybackError(Throwable error) {
        android.util.Log.e("SPlayerTV", "Playback failed", error);
        preparing = false;
        ready = false;
        status.setText(R.string.player_error);
        status.setTextColor(getColor(R.color.error));
        status.setVisibility(View.VISIBLE);
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        if (player != null) player.setDisplay(null);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                || keyCode == KeyEvent.KEYCODE_DPAD_CENTER
                || keyCode == KeyEvent.KEYCODE_ENTER) {
            if (!ready) return true;
            if (isPlaying()) pause();
            else start();
            controller.show();
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT && ready) {
            seekTo(Math.max(0, getCurrentPosition() - 10_000));
            controller.show();
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT && ready) {
            seekTo(Math.min(getDuration(), getCurrentPosition() + 10_000));
            controller.show();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void start() {
        if (ready && player != null) player.start();
    }

    @Override
    public void pause() {
        if (ready && player != null) player.pause();
    }

    @Override
    public int getDuration() {
        return ready && player != null ? player.getDuration() : 0;
    }

    @Override
    public int getCurrentPosition() {
        return ready && player != null ? player.getCurrentPosition() : 0;
    }

    @Override
    public void seekTo(int position) {
        if (ready && player != null) player.seekTo(position);
    }

    @Override
    public boolean isPlaying() {
        return ready && player != null && player.isPlaying();
    }

    @Override
    public int getBufferPercentage() {
        return 0;
    }

    @Override
    public boolean canPause() {
        return true;
    }

    @Override
    public boolean canSeekBackward() {
        return true;
    }

    @Override
    public boolean canSeekForward() {
        return true;
    }

    @Override
    public int getAudioSessionId() {
        return player == null ? 0 : player.getAudioSessionId();
    }

    @Override
    protected void onPause() {
        if (isPlaying()) player.pause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        ready = false;
        networkExecutor.shutdownNow();
        if (player != null) {
            player.reset();
            player.release();
            player = null;
        }
        if (smbDataSource != null) {
            try {
                smbDataSource.close();
            } catch (Exception ignored) {
            }
            smbDataSource = null;
        }
        super.onDestroy();
    }
}
