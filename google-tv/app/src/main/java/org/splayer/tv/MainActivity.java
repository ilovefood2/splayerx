package org.splayer.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.splayer.tv.data.FavoriteStore;
import org.splayer.tv.model.NetworkEntry;
import org.splayer.tv.model.NetworkLocation;
import org.splayer.tv.network.MediaTypes;
import org.splayer.tv.network.NetworkBrowser;
import org.splayer.tv.ui.TvUi;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;

public final class MainActivity extends Activity {
    private FavoriteStore favoriteStore;
    private NetworkBrowser networkBrowser;
    private LinearLayout favoriteList;
    private LinearLayout entryList;
    private TextView emptyFavorites;
    private TextView browserTitle;
    private TextView status;
    private Button refreshButton;
    private Button backButton;
    private Button addButton;
    private NetworkLocation currentLocation;
    private String currentUri;
    private final Deque<String> browseHistory = new ArrayDeque<>();

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
        favoriteStore = new FavoriteStore(this);
        networkBrowser = new NetworkBrowser();
        setContentView(buildContent());
        renderFavorites();
        showFavoritesHome();
    }

    private View buildContent() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(TvUi.dp(this, 54), TvUi.dp(this, 34), TvUi.dp(this, 54), TvUi.dp(this, 30));
        root.setBackgroundColor(getColor(R.color.background));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = TvUi.text(this, getString(R.string.app_name), 30, Color.WHITE);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        addButton = TvUi.button(this, "＋  " + getString(R.string.add_location));
        addButton.setOnClickListener(view -> showAddLocationDialog());
        header.addView(addButton, new LinearLayout.LayoutParams(
                TvUi.dp(this, 280),
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        root.addView(header);

        TextView favoritesHeading = TvUi.text(
                this,
                getString(R.string.network_locations),
                19,
                getColor(R.color.text_primary)
        );
        LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        headingParams.topMargin = TvUi.dp(this, 22);
        headingParams.bottomMargin = TvUi.dp(this, 10);
        root.addView(favoritesHeading, headingParams);

        HorizontalScrollView favoriteScroll = new HorizontalScrollView(this);
        favoriteScroll.setHorizontalScrollBarEnabled(false);
        favoriteList = new LinearLayout(this);
        favoriteList.setOrientation(LinearLayout.HORIZONTAL);
        favoriteList.setPadding(TvUi.dp(this, 3), TvUi.dp(this, 3), TvUi.dp(this, 3), TvUi.dp(this, 6));
        favoriteScroll.addView(favoriteList);
        root.addView(favoriteScroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                TvUi.dp(this, 112)
        ));

        emptyFavorites = TvUi.text(
                this,
                getString(R.string.empty_locations),
                15,
                getColor(R.color.text_secondary)
        );
        root.addView(emptyFavorites);

        LinearLayout browserHeader = new LinearLayout(this);
        browserHeader.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams browserHeaderParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        browserHeaderParams.topMargin = TvUi.dp(this, 20);
        browserTitle = TvUi.text(this, getString(R.string.browse_hint), 20, Color.WHITE);
        browserHeader.addView(browserTitle, new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1
        ));
        backButton = TvUi.button(this, "←  " + getString(R.string.back_to_favorites));
        backButton.setOnClickListener(view -> navigateBack());
        browserHeader.addView(backButton, compactButtonParams());
        refreshButton = TvUi.button(this, "↻  " + getString(R.string.refresh));
        refreshButton.setOnClickListener(view -> {
            if (currentLocation != null && currentUri != null) {
                browse(currentLocation, currentUri, true, false);
            }
        });
        LinearLayout.LayoutParams refreshParams = compactButtonParams();
        refreshParams.leftMargin = TvUi.dp(this, 10);
        browserHeader.addView(refreshButton, refreshParams);
        root.addView(browserHeader, browserHeaderParams);

        status = TvUi.text(this, "", 15, getColor(R.color.text_secondary));
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        statusParams.topMargin = TvUi.dp(this, 8);
        statusParams.bottomMargin = TvUi.dp(this, 8);
        root.addView(status, statusParams);

        ScrollView entryScroll = new ScrollView(this);
        entryScroll.setFillViewport(true);
        entryList = new LinearLayout(this);
        entryList.setOrientation(LinearLayout.VERTICAL);
        entryList.setPadding(TvUi.dp(this, 3), TvUi.dp(this, 2), TvUi.dp(this, 3), TvUi.dp(this, 8));
        entryScroll.addView(entryList);
        root.addView(entryScroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1
        ));
        return root;
    }

    private LinearLayout.LayoutParams compactButtonParams() {
        return new LinearLayout.LayoutParams(
                TvUi.dp(this, 190),
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
    }

    private void renderFavorites() {
        favoriteList.removeAllViews();
        List<NetworkLocation> locations = favoriteStore.getAll();
        emptyFavorites.setVisibility(locations.isEmpty() ? View.VISIBLE : View.GONE);
        for (NetworkLocation location : locations) {
            favoriteList.addView(createFavoriteCard(location));
        }
    }

    private View createFavoriteCard(NetworkLocation location) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                TvUi.dp(this, 290),
                ViewGroup.LayoutParams.MATCH_PARENT
        );
        cardParams.rightMargin = TvUi.dp(this, 13);
        card.setLayoutParams(cardParams);

        Button open = TvUi.button(this, "★  " + location.getName() + "\n" + location.getAddress());
        open.setTextSize(14);
        open.setSingleLine(false);
        open.setOnClickListener(view -> openLocation(location));
        card.addView(open, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1
        ));

        Button remove = TvUi.button(this, getString(R.string.remove));
        remove.setTextSize(12);
        remove.setGravity(Gravity.CENTER);
        remove.setMinHeight(0);
        remove.setOnClickListener(view -> confirmRemove(location));
        card.addView(remove, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                TvUi.dp(this, 38)
        ));
        return card;
    }

    private void showAddLocationDialog() {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        int padding = TvUi.dp(this, 24);
        form.setPadding(padding, TvUi.dp(this, 8), padding, 0);

        EditText name = field(getString(R.string.location_name));
        EditText address = field(getString(R.string.location_address));
        EditText username = field(getString(R.string.username_optional));
        EditText password = field(getString(R.string.password_optional));
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        TextView note = TvUi.text(
                this,
                getString(R.string.credentials_note),
                12,
                getColor(R.color.text_secondary)
        );
        form.addView(name);
        form.addView(address);
        form.addView(username);
        form.addView(password);
        form.addView(note);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.add_location)
                .setView(form)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.save_and_open, null)
                .create();
        dialog.setOnShowListener(ignored -> dialog
                .getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(view -> {
                    try {
                        NetworkLocation location = NetworkLocation.create(
                                name.getText().toString(),
                                address.getText().toString(),
                                username.getText().toString(),
                                password.getText().toString()
                        );
                        favoriteStore.upsert(location);
                        renderFavorites();
                        dialog.dismiss();
                        openLocation(location);
                    } catch (IllegalArgumentException error) {
                        address.setError(getString(R.string.invalid_location));
                        address.requestFocus();
                    }
                }));
        dialog.show();
    }

    private EditText field(String hint) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setSingleLine(true);
        field.setTextColor(Color.WHITE);
        field.setHintTextColor(getColor(R.color.text_secondary));
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setPadding(0, TvUi.dp(this, 8), 0, TvUi.dp(this, 8));
        return field;
    }

    private void confirmRemove(NetworkLocation location) {
        new AlertDialog.Builder(this)
                .setTitle(location.getName())
                .setMessage(location.getAddress())
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.remove, (dialog, which) -> {
                    favoriteStore.remove(location.getId());
                    if (currentLocation != null && currentLocation.getId().equals(location.getId())) {
                        showFavoritesHome();
                    }
                    renderFavorites();
                    addButton.requestFocus();
                })
                .show();
    }

    private void openLocation(NetworkLocation location) {
        browseHistory.clear();
        if (MediaTypes.isPlayable(location.getAddress())) {
            play(location, location.getAddress(), location.getName());
            return;
        }
        browse(location, location.getAddress(), false, false);
    }

    private void browse(
            NetworkLocation location,
            String uri,
            boolean forceRefresh,
            boolean addHistory
    ) {
        if (addHistory && currentUri != null) browseHistory.push(currentUri);
        currentLocation = location;
        currentUri = uri;
        browserTitle.setText(location.getName() + "  ·  " + uri);
        backButton.setVisibility(View.VISIBLE);
        refreshButton.setVisibility(View.VISIBLE);
        entryList.removeAllViews();
        status.setText(R.string.loading);
        final String requestUri = uri;
        networkBrowser.browse(location, uri, forceRefresh, new NetworkBrowser.Callback() {
            @Override
            public void onSuccess(List<NetworkEntry> entries) {
                if (!requestUri.equals(currentUri)) return;
                renderEntries(location, entries);
            }

            @Override
            public void onError(Throwable error) {
                if (!requestUri.equals(currentUri)) return;
                status.setTextColor(getColor(R.color.error));
                status.setText(R.string.network_error);
            }
        });
    }

    private void renderEntries(NetworkLocation location, List<NetworkEntry> entries) {
        entryList.removeAllViews();
        status.setTextColor(getColor(R.color.text_secondary));
        status.setText(entries.isEmpty() ? getString(R.string.no_media) : "");
        for (NetworkEntry entry : entries) {
            Button button = TvUi.button(
                    this,
                    (entry.isDirectory() ? "▸  " : "▶  ") + entry.getName()
            );
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
            );
            params.bottomMargin = TvUi.dp(this, 8);
            button.setOnClickListener(view -> {
                if (entry.isDirectory()) {
                    browse(location, entry.getUri(), false, true);
                } else {
                    play(location, entry.getUri(), entry.getName());
                }
            });
            entryList.addView(button, params);
        }
        if (entryList.getChildCount() > 0) entryList.getChildAt(0).requestFocus();
    }

    private void play(NetworkLocation location, String uri, String name) {
        startActivity(PlayerActivity.intent(this, location, uri, name));
    }

    private void navigateBack() {
        if (!browseHistory.isEmpty() && currentLocation != null) {
            browse(currentLocation, browseHistory.pop(), false, false);
        } else {
            showFavoritesHome();
        }
    }

    private void showFavoritesHome() {
        currentLocation = null;
        currentUri = null;
        browseHistory.clear();
        networkBrowser.clear();
        browserTitle.setText(R.string.browse_hint);
        status.setText("");
        status.setTextColor(getColor(R.color.text_secondary));
        entryList.removeAllViews();
        backButton.setVisibility(View.GONE);
        refreshButton.setVisibility(View.GONE);
        addButton.requestFocus();
    }

    @Override
    public void onBackPressed() {
        if (currentLocation != null) {
            navigateBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        networkBrowser.shutdown();
        super.onDestroy();
    }
}
