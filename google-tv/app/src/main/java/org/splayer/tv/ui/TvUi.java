package org.splayer.tv.ui;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.util.TypedValue;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;

import org.splayer.tv.R;

public final class TvUi {
    private TvUi() {
    }

    public static int dp(Context context, int value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP,
                value,
                context.getResources().getDisplayMetrics()
        ));
    }

    public static Button button(Context context, String text) {
        Button button = new Button(context);
        button.setText(text);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        button.setTextColor(Color.WHITE);
        button.setAllCaps(false);
        button.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL);
        button.setPadding(dp(context, 18), dp(context, 10), dp(context, 18), dp(context, 10));
        button.setMinHeight(dp(context, 56));
        button.setBackground(buttonBackground(context));
        button.setOnFocusChangeListener(TvUi::animateFocus);
        return button;
    }

    public static TextView text(Context context, String text, float sizeSp, int color) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        view.setTextColor(color);
        return view;
    }

    private static StateListDrawable buttonBackground(Context context) {
        StateListDrawable states = new StateListDrawable();
        states.addState(
                new int[]{android.R.attr.state_focused},
                rounded(context, R.color.surface_focus, R.color.primary, 3)
        );
        states.addState(
                new int[]{android.R.attr.state_pressed},
                rounded(context, R.color.surface_focus, R.color.text_primary, 2)
        );
        states.addState(
                new int[]{},
                rounded(context, R.color.surface, android.R.color.transparent, 0)
        );
        return states;
    }

    private static GradientDrawable rounded(
            Context context,
            int fillColor,
            int strokeColor,
            int strokeWidth
    ) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(context.getColor(fillColor));
        drawable.setCornerRadius(dp(context, 9));
        if (strokeWidth > 0) {
            drawable.setStroke(dp(context, strokeWidth), context.getColor(strokeColor));
        }
        return drawable;
    }

    private static void animateFocus(View view, boolean focused) {
        view.animate()
                .scaleX(focused ? 1.04f : 1f)
                .scaleY(focused ? 1.04f : 1f)
                .setDuration(120)
                .start();
    }
}
