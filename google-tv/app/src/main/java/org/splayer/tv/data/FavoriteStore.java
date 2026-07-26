package org.splayer.tv.data;

import android.content.Context;
import android.content.SharedPreferences;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

import org.splayer.tv.model.NetworkLocation;

import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.List;

public final class FavoriteStore {
    private static final String PREFERENCES = "network_locations";
    private static final String LOCATIONS = "favorites";
    private static final Type LOCATION_LIST = new TypeToken<List<NetworkLocation>>() { }.getType();

    private final SharedPreferences preferences;
    private final Gson gson = new Gson();

    public FavoriteStore(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    public List<NetworkLocation> getAll() {
        String json = preferences.getString(LOCATIONS, "[]");
        List<NetworkLocation> locations = gson.fromJson(json, LOCATION_LIST);
        return locations == null ? new ArrayList<>() : new ArrayList<>(locations);
    }

    public void upsert(NetworkLocation location) {
        List<NetworkLocation> locations = getAll();
        locations.removeIf(item -> item.getId().equals(location.getId())
                || (item.getAddress().equals(location.getAddress())
                && item.getUsername().equals(location.getUsername())));
        locations.add(location);
        save(locations);
    }

    public void remove(String locationId) {
        List<NetworkLocation> locations = getAll();
        locations.removeIf(item -> item.getId().equals(locationId));
        save(locations);
    }

    private void save(List<NetworkLocation> locations) {
        preferences.edit().putString(LOCATIONS, gson.toJson(locations, LOCATION_LIST)).apply();
    }
}
