package org.splayer.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.splayer.tv.data.FavoriteStore;
import org.splayer.tv.model.NetworkEntry;
import org.splayer.tv.model.NetworkLocation;
import org.splayer.tv.network.MediaTypes;
import org.splayer.tv.network.NetworkBrowser;
import org.splayer.tv.network.RemoteFiles;
import org.splayer.tv.ui.DeleteConfirmation;
import org.splayer.tv.ui.TvUi;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class MainActivity extends Activity {
    private static final int PLAY_VIDEO = 1;
    private FavoriteStore favoriteStore;
    private NetworkBrowser networkBrowser;
    private LinearLayout favoritesPanel;
    private LinearLayout favoriteList;
    private LinearLayout entryList;
    private LinearLayout toolbar;
    private TextView emptyFavorites;
    private TextView browserTitle;
    private TextView status;
    private TextView help;
    private Button refreshButton;
    private Button backButton;
    private Button addButton;
    private Button selectButton;
    private Button selectAllButton;
    private Button deleteButton;
    private NetworkLocation currentLocation;
    private String currentUri;
    private String focusUri;
    private boolean selecting;
    private boolean loading;
    private boolean deleting;
    private int requestId;
    private final Deque<String> browseHistory = new ArrayDeque<>();
    private final List<NetworkEntry> entries = new ArrayList<>();
    private final Set<String> selected = new LinkedHashSet<>();
    private final Map<String, Button> entryButtons = new LinkedHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        favoriteStore = new FavoriteStore(this);
        networkBrowser = new NetworkBrowser();
        setContentView(buildContent());
        renderFavorites();
        showFavoritesHome();
    }

    private View buildContent() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(TvUi.dp(this, 42), TvUi.dp(this, 24), TvUi.dp(this, 42), TvUi.dp(this, 24));
        root.setBackgroundColor(getColor(R.color.background));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = TvUi.text(this, getString(R.string.app_name), 28, Color.WHITE);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        addButton = TvUi.button(this, getString(R.string.add_location));
        addButton.setOnClickListener(view -> showLocationDialog(null));
        header.addView(addButton, new LinearLayout.LayoutParams(TvUi.dp(this, 250),
                ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(header);

        favoritesPanel = new LinearLayout(this);
        favoritesPanel.setOrientation(LinearLayout.VERTICAL);
        TextView heading = TvUi.text(this, getString(R.string.network_locations), 18,
                getColor(R.color.text_secondary));
        heading.setPadding(0, TvUi.dp(this, 16), 0, TvUi.dp(this, 8));
        favoritesPanel.addView(heading);
        HorizontalScrollView favoriteScroll = new HorizontalScrollView(this);
        favoriteScroll.setHorizontalScrollBarEnabled(false);
        favoriteList = new LinearLayout(this);
        favoriteList.setOrientation(LinearLayout.HORIZONTAL);
        favoriteList.setPadding(TvUi.dp(this, 3), TvUi.dp(this, 3), TvUi.dp(this, 3), TvUi.dp(this, 3));
        favoriteScroll.addView(favoriteList);
        favoritesPanel.addView(favoriteScroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, TvUi.dp(this, 92)));
        emptyFavorites = TvUi.text(this, getString(R.string.empty_locations), 17,
                getColor(R.color.text_secondary));
        favoritesPanel.addView(emptyFavorites);
        root.addView(favoritesPanel);

        browserTitle = TvUi.text(this, "", 19, Color.WHITE);
        browserTitle.setSingleLine(true);
        browserTitle.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        browserTitle.setPadding(0, TvUi.dp(this, 14), 0, TvUi.dp(this, 10));
        root.addView(browserTitle);

        toolbar = new LinearLayout(this);
        backButton = action(toolbar, R.string.back_to_favorites, view -> navigateBack());
        refreshButton = action(toolbar, R.string.refresh, view -> reload(true));
        selectButton = action(toolbar, R.string.select_files, view -> {
            selecting = !selecting;
            selected.clear();
            updateSelection();
        });
        selectAllButton = action(toolbar, R.string.select_all, view -> {
            boolean all = selected.size() == deletableEntries().size();
            selected.clear();
            if (!all) for (NetworkEntry entry : deletableEntries()) selected.add(entry.getUri());
            updateSelection();
        });
        deleteButton = action(toolbar, R.string.delete_files, view -> confirmSelectedDeletion());
        deleteButton.setTextColor(getColor(R.color.error));
        root.addView(toolbar);

        status = TvUi.text(this, "", 15, getColor(R.color.text_secondary));
        status.setPadding(0, TvUi.dp(this, 8), 0, TvUi.dp(this, 8));
        root.addView(status);
        ScrollView entryScroll = new ScrollView(this);
        entryScroll.setFillViewport(true);
        entryList = new LinearLayout(this);
        entryList.setOrientation(LinearLayout.VERTICAL);
        entryList.setPadding(TvUi.dp(this, 3), TvUi.dp(this, 3), TvUi.dp(this, 3), TvUi.dp(this, 3));
        entryScroll.addView(entryList);
        root.addView(entryScroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        help = TvUi.text(this, "", 14, getColor(R.color.text_secondary));
        help.setPadding(0, TvUi.dp(this, 8), 0, 0);
        root.addView(help);
        return root;
    }

    private Button action(LinearLayout row, int label, View.OnClickListener listener) {
        Button button = TvUi.button(this, getString(label));
        button.setTextSize(15);
        button.setGravity(Gravity.CENTER);
        button.setPadding(TvUi.dp(this, 8), TvUi.dp(this, 8), TvUi.dp(this, 8), TvUi.dp(this, 8));
        button.setOnClickListener(listener);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        params.setMarginEnd(TvUi.dp(this, 8));
        row.addView(button, params);
        return button;
    }

    private void renderFavorites() {
        favoriteList.removeAllViews();
        List<NetworkLocation> locations = favoriteStore.getAll();
        emptyFavorites.setVisibility(locations.isEmpty() ? View.VISIBLE : View.GONE);
        for (NetworkLocation location : locations) {
            Button button = TvUi.button(this, "★  " + location.getName() + "\n" + location.getAddress());
            button.setTextSize(16);
            button.setMaxLines(2);
            button.setEllipsize(TextUtils.TruncateAt.END);
            button.setOnClickListener(view -> openLocation(location));
            button.setOnLongClickListener(view -> {
                new AlertDialog.Builder(this).setTitle(location.getName())
                        .setItems(new String[]{getString(R.string.edit_location),
                                getString(R.string.remove_favorite)}, (dialog, which) -> {
                            if (which == 0) showLocationDialog(location);
                            else confirmRemove(location);
                        }).show();
                return true;
            });
            button.setNextFocusUpId(addButton.getId());
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(TvUi.dp(this, 320),
                    ViewGroup.LayoutParams.MATCH_PARENT);
            params.setMarginEnd(TvUi.dp(this, 12));
            favoriteList.addView(button, params);
        }
        addButton.setNextFocusDownId(locations.isEmpty() ? View.NO_ID : favoriteList.getChildAt(0).getId());
    }

    private void showLocationDialog(NetworkLocation existing) {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        int padding = TvUi.dp(this, 24);
        form.setPadding(padding, TvUi.dp(this, 8), padding, 0);
        EditText name = field(R.string.location_name, InputType.TYPE_CLASS_TEXT);
        EditText address = field(R.string.location_address,
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        EditText username = field(R.string.username_optional, InputType.TYPE_CLASS_TEXT);
        EditText password = field(R.string.password_optional,
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setTransformationMethod(android.text.method.PasswordTransformationMethod.getInstance());
        EditText[] fields = {name, address, username, password};
        for (int index = 0; index < fields.length; index++) {
            form.addView(fields[index]);
            if (index + 1 < fields.length) fields[index].setNextFocusDownId(fields[index + 1].getId());
        }
        password.setImeOptions(EditorInfo.IME_ACTION_DONE);
        TextView note = TvUi.text(this, getString(R.string.credentials_note), 12,
                getColor(R.color.text_secondary));
        form.addView(note);
        if (existing != null) {
            name.setText(existing.getName());
            address.setText(existing.getAddress());
            username.setText(existing.getUsername());
            password.setText(existing.getPassword());
        }
        ScrollView scroll = new ScrollView(this);
        scroll.addView(form);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(existing == null ? R.string.add_location : R.string.edit_location)
                .setView(scroll).setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.save_and_open, null).create();
        dialog.setOnShowListener(ignored -> {
            Button save = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            name.requestFocusFromTouch();
            password.setNextFocusDownId(save.getId());
            password.setOnEditorActionListener((view, actionId, event) -> {
                if (actionId != EditorInfo.IME_ACTION_DONE) return false;
                save.performClick();
                return true;
            });
            save.setOnClickListener(view -> {
                try {
                    NetworkLocation location = NetworkLocation.create(name.getText().toString(),
                            address.getText().toString(), username.getText().toString(),
                            password.getText().toString());
                    if (existing != null) location = new NetworkLocation(existing.getId(),
                            location.getName(), location.getAddress(), location.getUsername(), location.getPassword());
                    favoriteStore.upsert(location);
                    networkBrowser.clear();
                    renderFavorites();
                    dialog.dismiss();
                    openLocation(location);
                } catch (IllegalArgumentException error) {
                    address.setError(getString(R.string.invalid_location));
                    address.requestFocusFromTouch();
                }
            });
        });
        dialog.show();
    }

    private EditText field(int hint, int inputType) {
        EditText field = new EditText(this);
        field.setId(View.generateViewId());
        field.setHint(hint);
        field.setInputType(inputType);
        field.setSingleLine(true);
        field.setImeOptions(EditorInfo.IME_ACTION_NEXT);
        field.setTextColor(Color.WHITE);
        field.setHintTextColor(getColor(R.color.text_secondary));
        field.setPadding(0, TvUi.dp(this, 8), 0, TvUi.dp(this, 8));
        return field;
    }

    private void confirmRemove(NetworkLocation location) {
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(R.string.remove_favorite)
                .setMessage(getString(R.string.remove_favorite_message, location.getName()))
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.remove, (ignored, which) -> {
                    favoriteStore.remove(location.getId());
                    renderFavorites();
                    showFavoritesHome();
                }).create();
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).requestFocusFromTouch();
        });
        dialog.show();
    }

    private void openLocation(NetworkLocation location) {
        browseHistory.clear();
        if (MediaTypes.isPlayable(location.getAddress())) {
            play(location, new NetworkEntry(location.getName(), location.getAddress(), false));
        } else {
            loadFolder(location, location.getAddress(), false, false, false);
        }
    }

    private void reload(boolean keepSelection) {
        if (currentLocation != null && currentUri != null) {
            loadFolder(currentLocation, currentUri, true, false, keepSelection);
        }
    }

    private void loadFolder(NetworkLocation location, String uri, boolean refresh,
                            boolean addHistory, boolean keepSelection) {
        if (addHistory && currentUri != null) browseHistory.push(currentUri);
        currentLocation = location;
        currentUri = uri;
        if (!keepSelection) { selecting = false; selected.clear(); }
        loading = true;
        final int request = ++requestId;
        favoritesPanel.setVisibility(View.GONE);
        addButton.setVisibility(View.GONE);
        toolbar.setVisibility(View.VISIBLE);
        browserTitle.setText(location.getName() + "  ·  " + uri);
        entries.clear();
        entryButtons.clear();
        entryList.removeAllViews();
        status.setTextColor(getColor(R.color.text_secondary));
        status.setText(R.string.loading);
        updateSelection();
        networkBrowser.browse(location, uri, refresh, new NetworkBrowser.Callback() {
            @Override public void onSuccess(List<NetworkEntry> result) {
                if (request != requestId || isFinishing() || isDestroyed()) return;
                loading = false;
                entries.addAll(result);
                Set<String> available = new LinkedHashSet<>();
                for (NetworkEntry entry : deletableEntries()) available.add(entry.getUri());
                selected.retainAll(available);
                renderEntries();
            }
            @Override public void onError(Throwable error) {
                if (request != requestId || isFinishing() || isDestroyed()) return;
                loading = false;
                updateSelection();
                status.setTextColor(getColor(R.color.error));
                status.setText(R.string.network_error);
                refreshButton.requestFocusFromTouch();
            }
        });
    }

    private void renderEntries() {
        entryList.removeAllViews();
        entryButtons.clear();
        for (NetworkEntry entry : entries) {
            Button button = TvUi.button(this, "");
            button.setTextSize(18);
            button.setSingleLine(true);
            button.setEllipsize(TextUtils.TruncateAt.MIDDLE);
            button.setOnClickListener(view -> {
                focusUri = entry.getUri();
                if (selecting) {
                    if (selected.contains(entry.getUri())) selected.remove(entry.getUri());
                    else selected.add(entry.getUri());
                    updateSelection();
                } else if (entry.isDirectory()) {
                    loadFolder(currentLocation, entry.getUri(), false, true, false);
                } else play(currentLocation, entry);
            });
            button.setOnLongClickListener(view -> {
                if (!RemoteFiles.canDelete(currentLocation, entry)) return false;
                selecting = true;
                selected.add(entry.getUri());
                updateSelection();
                return true;
            });
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            params.bottomMargin = TvUi.dp(this, 6);
            entryList.addView(button, params);
            entryButtons.put(entry.getUri(), button);
        }
        updateSelection();
        View target = entryButtons.get(focusUri);
        if (target == null || !target.isEnabled()) {
            target = null;
            for (Button button : entryButtons.values()) if (button.isEnabled()) { target = button; break; }
        }
        if (target == null) target = selectButton;
        target.requestFocusFromTouch();
    }

    private List<NetworkEntry> deletableEntries() {
        List<NetworkEntry> files = new ArrayList<>();
        for (NetworkEntry entry : entries) if (RemoteFiles.canDelete(currentLocation, entry)) files.add(entry);
        return files;
    }

    private void updateSelection() {
        boolean available = currentLocation != null && !loading && !deleting;
        List<NetworkEntry> deletable = deletableEntries();
        backButton.setEnabled(!deleting);
        refreshButton.setEnabled(available);
        selectButton.setEnabled(available && !deletable.isEmpty());
        selectButton.setText(selecting ? R.string.done_selecting : R.string.select_files);
        selectAllButton.setVisibility(selecting ? View.VISIBLE : View.GONE);
        deleteButton.setVisibility(selecting ? View.VISIBLE : View.GONE);
        selectAllButton.setEnabled(available && !deletable.isEmpty());
        selectAllButton.setText(!selected.isEmpty() && selected.size() == deletable.size()
                ? R.string.clear_selection : R.string.select_all);
        deleteButton.setText(getString(R.string.delete_count, selected.size()));
        deleteButton.setEnabled(available && !selected.isEmpty());
        for (NetworkEntry entry : entries) {
            Button button = entryButtons.get(entry.getUri());
            if (button == null) continue;
            boolean checked = selected.contains(entry.getUri());
            String prefix = entry.isDirectory() ? "▸  " : selecting ? (checked ? "☑  " : "☐  ") : "▶  ";
            button.setText(prefix + entry.getName());
            button.setContentDescription((checked ? getString(R.string.selected) + ", " : "") + entry.getName());
            button.setSelected(checked);
            button.setEnabled(!deleting && (!selecting || RemoteFiles.canDelete(currentLocation, entry)));
            button.setAlpha(button.isEnabled() ? 1f : 0.45f);
        }
        Button first = null;
        Button previous = null;
        for (Button button : entryButtons.values()) {
            if (!button.isEnabled()) continue;
            if (first == null) first = button;
            button.setNextFocusUpId(previous == null
                    ? (selecting && !selected.isEmpty() ? deleteButton.getId() : selectButton.getId())
                    : previous.getId());
            if (previous != null) previous.setNextFocusDownId(button.getId());
            button.setNextFocusDownId(View.NO_ID);
            previous = button;
        }
        for (int i = 0; i < toolbar.getChildCount(); i++) {
            toolbar.getChildAt(i).setNextFocusDownId(first == null ? View.NO_ID : first.getId());
        }
        if (!loading && !deleting && currentLocation != null) {
            status.setTextColor(getColor(R.color.text_secondary));
            status.setText(entries.isEmpty() ? getString(R.string.no_media)
                    : selecting ? getString(R.string.selected_count, selected.size())
                    : getString(R.string.item_count, entries.size()));
        }
        help.setText(currentLocation == null ? R.string.favorites_help
                : selecting ? R.string.selection_help : R.string.browser_help);
    }

    private void confirmSelectedDeletion() {
        List<NetworkEntry> files = new ArrayList<>();
        for (NetworkEntry entry : entries) if (selected.contains(entry.getUri())) files.add(entry);
        if (files.isEmpty() || deleting) return;
        DeleteConfirmation.show(this, files, () -> {
            deleting = true;
            ++requestId;
            updateSelection();
            status.setText(R.string.deleting);
            networkBrowser.deleteFiles(currentLocation, files, result -> {
                deleting = false;
                selected.clear();
                for (NetworkEntry entry : result.failed) selected.add(entry.getUri());
                String message = getString(R.string.delete_result, result.deleted.size(), result.failed.size());
                if (!result.failed.isEmpty()) {
                    StringBuilder failed = new StringBuilder(message).append("\n\n")
                            .append(getString(R.string.delete_failed)).append("\n\n");
                    for (NetworkEntry entry : result.failed) failed.append(entry.getName()).append('\n');
                    new AlertDialog.Builder(this).setTitle(R.string.delete_result_title)
                            .setMessage(failed.toString()).setPositiveButton(android.R.string.ok, null).show();
                } else Toast.makeText(this, message, Toast.LENGTH_LONG).show();
                selecting = !selected.isEmpty();
                reload(true);
            });
        });
    }

    private void play(NetworkLocation location, NetworkEntry entry) {
        focusUri = entry.getUri();
        startActivityForResult(PlayerActivity.intent(this, location, entry.getUri(), entry.getName()), PLAY_VIDEO);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PLAY_VIDEO) {
            networkBrowser.clear();
            reload(false);
        }
    }

    private void navigateBack() {
        if (deleting) return;
        if (selecting) {
            selecting = false;
            selected.clear();
            updateSelection();
            selectButton.requestFocusFromTouch();
        } else if (!browseHistory.isEmpty() && currentLocation != null) {
            loadFolder(currentLocation, browseHistory.pop(), false, false, false);
        } else showFavoritesHome();
    }

    private void showFavoritesHome() {
        ++requestId;
        currentLocation = null;
        currentUri = null;
        loading = false;
        selecting = false;
        selected.clear();
        entries.clear();
        entryButtons.clear();
        browseHistory.clear();
        networkBrowser.clear();
        favoritesPanel.setVisibility(View.VISIBLE);
        addButton.setVisibility(View.VISIBLE);
        toolbar.setVisibility(View.GONE);
        browserTitle.setText(R.string.browse_hint);
        status.setText("");
        entryList.removeAllViews();
        updateSelection();
        if (favoriteList.getChildCount() > 0) favoriteList.getChildAt(0).requestFocusFromTouch();
        else addButton.requestFocusFromTouch();
    }

    @Override
    public void onBackPressed() {
        if (deleting) return;
        if (currentLocation != null) navigateBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        ++requestId;
        networkBrowser.shutdown();
        super.onDestroy();
    }
}
