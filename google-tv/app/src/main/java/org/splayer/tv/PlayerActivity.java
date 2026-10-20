package org.splayer.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;

import org.splayer.tv.data.FavoriteStore;
import org.splayer.tv.model.NetworkEntry;
import org.splayer.tv.model.NetworkLocation;
import org.splayer.tv.network.RemoteFiles;
import org.splayer.tv.network.SmbMediaDataSource;
import org.splayer.tv.ui.DeleteConfirmation;
import org.splayer.tv.ui.TvUi;

import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class PlayerActivity extends Activity implements SurfaceHolder.Callback {
    private static final String EXTRA_LOCATION_ID = "location_id";
    private static final String EXTRA_MEDIA_URI = "media_uri";
    private static final String EXTRA_MEDIA_NAME = "media_name";
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SurfaceView surface;
    private FrameLayout controls;
    private TextView status;
    private TextView time;
    private SeekBar progress;
    private Button playButton;
    private Button deleteButton;
    private LinearLayout actionButtons;
    private MediaPlayer player;
    private MediaSession mediaSession;
    private SmbMediaDataSource smbDataSource;
    private NetworkLocation location;
    private NetworkEntry entry;
    private AlertDialog deleteDialog;
    private boolean preparing;
    private boolean ready;
    private boolean completed;
    private boolean deleting;
    private boolean tracking;
    private boolean autoStart = true;
    private volatile boolean destroyed;
    private int resumePosition;
    private final Runnable hideControls = () -> {
        if (isPlaying() && !deleting && (deleteDialog == null || !deleteDialog.isShowing())) {
            controls.setVisibility(View.GONE);
            surface.requestFocusFromTouch();
        }
    };
    private final Runnable progressTick = new Runnable() {
        @Override public void run() {
            if (destroyed) return;
            if (controls.getVisibility() == View.VISIBLE && isPlaying()) updateControls();
            handler.postDelayed(this, 1000);
        }
    };

    public static Intent intent(Context context, NetworkLocation location, String uri, String name) {
        // Resolve saved credentials inside the activity instead of placing them in an Intent.
        return new Intent(context, PlayerActivity.class)
                .putExtra(EXTRA_LOCATION_ID, location.getId())
                .putExtra(EXTRA_MEDIA_URI, uri).putExtra(EXTRA_MEDIA_NAME, name);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        String id = getIntent().getStringExtra(EXTRA_LOCATION_ID);
        for (NetworkLocation saved : new FavoriteStore(this).getAll()) {
            if (saved.getId().equals(id)) { location = saved; break; }
        }
        if (location == null) { finish(); return; }
        entry = new NetworkEntry(getIntent().getStringExtra(EXTRA_MEDIA_NAME),
                getIntent().getStringExtra(EXTRA_MEDIA_URI), false);
        if (savedInstanceState != null) {
            resumePosition = savedInstanceState.getInt("position");
            autoStart = savedInstanceState.getBoolean("playing");
        }
        setContentView(buildContent());
        mediaSession = new MediaSession(this, "SPlayerTV");
        mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() {
                autoStart = true;
                if (ready && !isPlaying()) togglePlayback();
                showControls();
            }
            @Override public void onPause() {
                autoStart = false;
                if (isPlaying()) togglePlayback();
                showControls();
            }
            @Override public void onSeekTo(long position) {
                if (ready && !deleting) {
                    completed = false;
                    player.seekTo((int) Math.max(0, Math.min(player.getDuration(), position)));
                    updateSession();
                }
            }
            @Override public void onStop() { if (!deleting) finish(); }
        }, handler);
        mediaSession.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, entry.getName()).build());
        mediaSession.setActive(true);
        updateSession();
    }

    private View buildContent() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        surface = new SurfaceView(this);
        surface.setKeepScreenOn(true);
        surface.setFocusable(true);
        surface.setFocusableInTouchMode(true);
        surface.setContentDescription(getString(R.string.video_surface));
        surface.setOnClickListener(view -> showControls());
        surface.getHolder().addCallback(this);
        root.addView(surface, new FrameLayout.LayoutParams(-1, -1));

        status = TvUi.text(this, getString(R.string.opening_video), 18, Color.WHITE);
        status.setGravity(Gravity.CENTER);
        status.setPadding(30, 20, 30, 20);
        root.addView(status, new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER));
        controls = new FrameLayout(this);
        root.addView(controls, new FrameLayout.LayoutParams(-1, -1));
        TextView title = TvUi.text(this, entry.getName(), 22, Color.WHITE);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        title.setPadding(TvUi.dp(this, 42), TvUi.dp(this, 24), TvUi.dp(this, 42), TvUi.dp(this, 18));
        title.setBackgroundColor(0xCC101218);
        controls.addView(title, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));

        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setPadding(TvUi.dp(this, 42), TvUi.dp(this, 16), TvUi.dp(this, 42), TvUi.dp(this, 24));
        bottom.setBackgroundColor(0xE6101218);
        time = TvUi.text(this, "", 16, Color.WHITE);
        bottom.addView(time);
        progress = new SeekBar(this);
        progress.setContentDescription(getString(R.string.seek_video));
        progress.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int value, boolean fromUser) {
                if (fromUser && ready && !tracking) player.seekTo(value);
            }
            @Override public void onStartTrackingTouch(SeekBar bar) { tracking = true; }
            @Override public void onStopTrackingTouch(SeekBar bar) {
                tracking = false;
                if (ready) player.seekTo(bar.getProgress());
                scheduleHide();
            }
        });
        bottom.addView(progress, new LinearLayout.LayoutParams(-1, TvUi.dp(this, 40)));
        LinearLayout buttons = new LinearLayout(this);
        actionButtons = buttons;
        addAction(buttons, R.string.back_to_files, view -> finish());
        addAction(buttons, R.string.rewind, view -> seekBy(-10_000));
        playButton = addAction(buttons, R.string.pause_video, view -> togglePlayback());
        addAction(buttons, R.string.forward, view -> seekBy(10_000));
        deleteButton = addAction(buttons, R.string.delete_file, view -> confirmDelete());
        deleteButton.setTextColor(getColor(R.color.error));
        deleteButton.setEnabled(false);
        bottom.addView(buttons);
        TextView hint = TvUi.text(this, getString(R.string.player_help), 13,
                getColor(R.color.text_secondary));
        hint.setPadding(0, TvUi.dp(this, 8), 0, 0);
        bottom.addView(hint);
        controls.addView(bottom, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        surface.requestFocusFromTouch();
        return root;
    }

    private Button addAction(LinearLayout row, int label, View.OnClickListener listener) {
        Button button = TvUi.button(this, getString(label));
        button.setTextSize(15);
        button.setGravity(Gravity.CENTER);
        button.setPadding(8, 8, 8, 8);
        button.setOnClickListener(listener);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
        params.setMarginEnd(TvUi.dp(this, 8));
        row.addView(button, params);
        return button;
    }

    @Override public void surfaceCreated(SurfaceHolder holder) {
        if (destroyed || deleting) return;
        if (player != null) { player.setDisplay(holder); return; }
        if (preparing) return;
        preparing = true;
        updateSession();
        updateControls();
        if ("smb".equals(location.getScheme())) {
            networkExecutor.execute(() -> {
                try {
                    SmbMediaDataSource source = new SmbMediaDataSource(location, entry.getUri());
                    synchronized (this) {
                        if (destroyed) { closeSource(source); return; }
                        smbDataSource = source;
                    }
                    handler.post(() -> {
                        if (destroyed) return;
                        configurePlayer(holder, source);
                    });
                } catch (Exception error) { handler.post(() -> showPlaybackError()); }
            });
        } else configurePlayer(holder, null);
    }

    private void configurePlayer(SurfaceHolder holder, SmbMediaDataSource source) {
        try {
            player = new MediaPlayer();
            if (holder.getSurface() != null && holder.getSurface().isValid()) player.setDisplay(holder);
            player.setAudioStreamType(AudioManager.STREAM_MUSIC);
            player.setWakeMode(this, android.os.PowerManager.PARTIAL_WAKE_LOCK);
            player.setOnPreparedListener(media -> {
                if (destroyed) return;
                preparing = false;
                ready = true;
                completed = false;
                if (resumePosition > 0) media.seekTo(Math.min(resumePosition, media.getDuration()));
                resumePosition = 0;
                status.setVisibility(View.GONE);
                if (autoStart) media.start();
                updateSession();
                showControls();
            });
            player.setOnErrorListener((media, what, extra) -> { showPlaybackError(); return true; });
            player.setOnCompletionListener(media -> {
                completed = true;
                updateSession();
                showControls();
            });
            if (source != null) player.setDataSource(source);
            else player.setDataSource(this, Uri.parse(entry.getUri()), authenticationHeaders());
            player.prepareAsync();
        } catch (Exception error) { showPlaybackError(); }
    }

    private Map<String, String> authenticationHeaders() {
        Map<String, String> headers = new HashMap<>();
        if (!location.getUsername().isEmpty() || !location.getPassword().isEmpty()) {
            String credentials = location.getUsername() + ":" + location.getPassword();
            headers.put("Authorization", "Basic " + Base64.encodeToString(
                    credentials.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        }
        return headers;
    }

    private void showPlaybackError() {
        if (destroyed) return;
        preparing = false;
        ready = false;
        status.setText(R.string.player_error);
        status.setTextColor(getColor(R.color.error));
        status.setVisibility(View.VISIBLE);
        updateSession();
        showControls();
    }

    private boolean isPlaying() { return ready && player != null && player.isPlaying(); }

    private void showControls() {
        controls.setVisibility(View.VISIBLE);
        updateControls();
        if (ready) playButton.requestFocusFromTouch();
        else deleteButton.requestFocusFromTouch();
        scheduleHide();
    }

    private void scheduleHide() {
        handler.removeCallbacks(hideControls);
        if (isPlaying() && !tracking) handler.postDelayed(hideControls, 6000);
    }

    private void updateControls() {
        if (playButton == null) return;
        for (int index = 0; index < actionButtons.getChildCount(); index++) {
            actionButtons.getChildAt(index).setEnabled(!deleting);
        }
        String label = getString(completed ? R.string.replay_video : isPlaying() ? R.string.pause_video : R.string.play_video);
        if (!label.contentEquals(playButton.getText())) playButton.setText(label);
        playButton.setEnabled(ready && !deleting);
        progress.setEnabled(ready && !deleting);
        deleteButton.setEnabled(!preparing && !deleting && RemoteFiles.canDelete(location, entry));
        if (ready && !tracking) {
            progress.setMax(player.getDuration());
            progress.setKeyProgressIncrement(10_000);
            progress.setProgress(player.getCurrentPosition());
            String clock = formatTime(player.getCurrentPosition()) + " / " + formatTime(player.getDuration());
            if (!clock.contentEquals(time.getText())) time.setText(clock);
        }
    }

    private static String formatTime(int milliseconds) {
        int seconds = Math.max(0, milliseconds / 1000);
        return seconds >= 3600
                ? String.format(Locale.ROOT, "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
                : String.format(Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60);
    }

    private void togglePlayback() {
        if (!ready || deleting) return;
        if (isPlaying()) player.pause();
        else {
            if (completed) { player.seekTo(0); completed = false; }
            player.start();
        }
        updateControls();
        updateSession();
        scheduleHide();
    }

    private void seekBy(int delta) {
        if (!ready || deleting) return;
        completed = false;
        player.seekTo(Math.max(0, Math.min(player.getDuration(), player.getCurrentPosition() + delta)));
        updateControls();
        updateSession();
        scheduleHide();
    }

    private void updateSession() {
        if (mediaSession == null) return;
        int state = preparing ? PlaybackState.STATE_BUFFERING
                : !ready ? PlaybackState.STATE_STOPPED
                : isPlaying() ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
        mediaSession.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP)
                .setState(state, ready ? player.getCurrentPosition() : 0, isPlaying() ? 1f : 0f).build());
    }

    private void confirmDelete() {
        if (deleting || preparing || !RemoteFiles.canDelete(location, entry)) return;
        boolean wasPlaying = isPlaying();
        int position = ready ? player.getCurrentPosition() : 0;
        if (wasPlaying) player.pause();
        updateSession();
        updateControls();
        deleteDialog = DeleteConfirmation.show(this, Collections.singletonList(entry),
                () -> deletePlayingFile(position, wasPlaying));
        deleteDialog.setOnDismissListener(dialog -> {
            if (!deleting && ready && wasPlaying) player.start();
            updateSession();
            updateControls();
            scheduleHide();
        });
    }

    private void deletePlayingFile(int position, boolean wasPlaying) {
        deleting = true;
        SmbMediaDataSource source = releasePlayback();
        updateSession();
        updateControls();
        status.setText(R.string.deleting);
        status.setVisibility(View.VISIBLE);
        networkExecutor.execute(() -> {
            boolean success;
            try {
                // Release the SMB read handle before asking the router to remove the file.
                if (source != null) source.close();
                success = RemoteFiles.deleteAll(location, Collections.singletonList(entry)).failed.isEmpty();
            } catch (Exception error) { success = false; }
            final boolean deleted = success;
            handler.post(() -> {
                if (destroyed) return;
                deleting = false;
                if (deleted) { setResult(RESULT_OK); finish(); }
                else {
                    autoStart = wasPlaying;
                    resumePosition = position;
                    status.setText(R.string.opening_video);
                    surfaceCreated(surface.getHolder());
                    new AlertDialog.Builder(this).setTitle(R.string.delete_result_title)
                            .setMessage(R.string.delete_failed)
                            .setPositiveButton(android.R.string.ok, null).show();
                }
            });
        });
    }

    private synchronized SmbMediaDataSource releasePlayback() {
        ready = false;
        preparing = false;
        if (player != null) {
            player.setOnPreparedListener(null);
            try { player.reset(); } finally { player.release(); player = null; }
        }
        SmbMediaDataSource source = smbDataSource;
        smbDataSource = null;
        return source;
    }

    private static void closeSource(SmbMediaDataSource source) {
        if (source != null) try { source.close(); } catch (Exception ignored) { }
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            int key = event.getKeyCode();
            if (deleting && key == KeyEvent.KEYCODE_BACK) return true;
            if (!deleting && (key == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                    || key == KeyEvent.KEYCODE_MEDIA_PLAY || key == KeyEvent.KEYCODE_MEDIA_PAUSE)) {
                if (event.getRepeatCount() == 0 && ready) {
                    if (key == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                            || (key == KeyEvent.KEYCODE_MEDIA_PLAY) != isPlaying()) togglePlayback();
                    showControls();
                }
                return true;
            }
            if (!deleting && (key == KeyEvent.KEYCODE_MENU || controls.getVisibility() != View.VISIBLE)) {
                if (key == KeyEvent.KEYCODE_DPAD_LEFT) { seekBy(-10_000); showControls(); return true; }
                if (key == KeyEvent.KEYCODE_DPAD_RIGHT) { seekBy(10_000); showControls(); return true; }
                if (key == KeyEvent.KEYCODE_MENU || key == KeyEvent.KEYCODE_DPAD_UP
                        || key == KeyEvent.KEYCODE_DPAD_DOWN || key == KeyEvent.KEYCODE_DPAD_CENTER
                        || key == KeyEvent.KEYCODE_ENTER) { showControls(); return true; }
            }
            scheduleHide();
        }
        return super.dispatchKeyEvent(event);
    }

    @Override public void onBackPressed() {
        if (deleting) return;
        if (controls.getVisibility() == View.VISIBLE && ready) {
            controls.setVisibility(View.GONE);
            surface.requestFocusFromTouch();
        } else finish();
    }

    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { }
    @Override public void surfaceDestroyed(SurfaceHolder holder) { if (player != null) player.setDisplay(null); }

    @Override protected void onResume() {
        super.onResume();
        if (controls != null) {
            handler.removeCallbacks(progressTick);
            handler.post(progressTick);
            if (ready) showControls();
        }
    }

    @Override protected void onPause() {
        if (isPlaying()) player.pause();
        updateSession();
        handler.removeCallbacks(progressTick);
        handler.removeCallbacks(hideControls);
        super.onPause();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putInt("position", ready ? player.getCurrentPosition() : resumePosition);
        state.putBoolean("playing", isPlaying());
        super.onSaveInstanceState(state);
    }

    @Override protected void onDestroy() {
        destroyed = true;
        if (mediaSession != null) { mediaSession.release(); mediaSession = null; }
        handler.removeCallbacksAndMessages(null);
        SmbMediaDataSource source = releasePlayback();
        networkExecutor.execute(() -> closeSource(source));
        networkExecutor.shutdown();
        super.onDestroy();
    }
}
