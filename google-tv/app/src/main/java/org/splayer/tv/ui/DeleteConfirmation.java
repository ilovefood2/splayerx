package org.splayer.tv.ui;

import android.app.Activity;
import android.app.AlertDialog;

import org.splayer.tv.R;
import org.splayer.tv.model.NetworkEntry;

import java.util.List;

public final class DeleteConfirmation {
    private DeleteConfirmation() { }

    public static AlertDialog show(Activity activity, List<NetworkEntry> entries, Runnable confirm) {
        StringBuilder message = new StringBuilder(activity.getString(R.string.delete_warning));
        message.append("\n\n");
        for (int index = 0; index < Math.min(entries.size(), 10); index++) {
            message.append(entries.get(index).getName()).append('\n');
        }
        if (entries.size() > 10) message.append(activity.getString(R.string.more_files, entries.size() - 10));
        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle(activity.getResources().getQuantityString(
                        R.plurals.delete_title, entries.size(), entries.size()))
                .setMessage(message.toString())
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.delete_files, (ignored, which) -> confirm.run())
                .create();
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(activity.getColor(R.color.error));
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).requestFocusFromTouch();
        });
        dialog.show();
        return dialog;
    }
}
