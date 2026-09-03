package com.lockandroll.nova;

import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;

/**
 * Square Point of Sale bridge.
 *
 * Why this exists: in a browser, Nova opens Square with an intent: URL and Chrome
 * launches it with startActivityForResult(). Inside the Capacitor WebView that
 * same URL is launched with plain startActivity(), and the Square app refuses it
 * with "Point of Sale API must be started with startActivityForResult() in the
 * same task". So the app builds the charge intent natively, starts it for a
 * result, and hands the extras straight back to the page, which posts them to
 * /api/square/pos-result exactly as the browser callback would.
 *
 * Extras and result keys are the public constants from Square's
 * point-of-sale-android-sdk (PosApi.java).
 */
@CapacitorPlugin(name = "SquarePos")
public class SquarePosPlugin extends Plugin {

  private static final String SQUARE_PACKAGE = "com.squareup";
  private static final String ACTION_CHARGE = "com.squareup.pos.action.CHARGE";

  private static String str(Intent data, String key) {
    String v = data.getStringExtra(key);
    return v == null ? "" : v;
  }

  private boolean squareInstalled() {
    Intent probe = new Intent(ACTION_CHARGE);
    probe.setPackage(SQUARE_PACKAGE);
    return probe.resolveActivity(getContext().getPackageManager()) != null;
  }

  @PluginMethod
  public void isAvailable(PluginCall call) {
    JSObject out = new JSObject();
    out.put("available", squareInstalled());
    call.resolve(out);
  }

  @PluginMethod
  public void charge(PluginCall call) {
    if (!squareInstalled()) {
      call.reject("The Square app is not installed on this phone.", "SQUARE_NOT_INSTALLED");
      return;
    }

    Intent intent = new Intent(ACTION_CHARGE);
    intent.setPackage(SQUARE_PACKAGE);
    intent.putExtra("com.squareup.pos.CLIENT_ID", call.getString("client_id", ""));
    intent.putExtra("com.squareup.pos.API_VERSION", call.getString("api_version", "v2.1"));
    intent.putExtra("com.squareup.pos.SDK_VERSION", "nova-capacitor-1");
    intent.putExtra("com.squareup.pos.TOTAL_AMOUNT", (long) call.getInt("amount_cents", 0));
    intent.putExtra("com.squareup.pos.CURRENCY_CODE", call.getString("currency_code", "USD"));
    intent.putExtra("com.squareup.pos.NOTE", call.getString("note", ""));
    intent.putExtra("com.squareup.pos.REQUEST_METADATA", call.getString("state", ""));

    String locationId = call.getString("location_id", "");
    if (locationId != null && locationId.length() > 0) {
      intent.putExtra("com.squareup.pos.LOCATION_ID", locationId);
    }

    ArrayList<String> tenders = new ArrayList<>();
    JSArray arr = call.getArray("tender_types");
    if (arr != null) {
      for (int i = 0; i < arr.length(); i++) {
        try { tenders.add(arr.getString(i)); } catch (Exception ignored) {}
      }
    }
    if (tenders.isEmpty()) tenders.add("com.squareup.pos.TENDER_CARD");
    intent.putStringArrayListExtra("com.squareup.pos.TENDER_TYPES", tenders);

    long autoReturn = (long) call.getInt("auto_return_ms", 3200);
    if (autoReturn > 0) intent.putExtra("com.squareup.pos.AUTO_RETURN_TIMEOUT_MS", autoReturn);

    // Same task, for a result. This is the whole point of the plugin.
    startActivityForResult(call, intent, "chargeResult");
  }

  @ActivityCallback
  private void chargeResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    JSObject out = new JSObject();
    Intent data = result.getData();
    out.put("result_code", result.getResultCode());
    out.put("ok", result.getResultCode() == Activity.RESULT_OK);
    if (data != null) {
      out.put("state", str(data, "com.squareup.pos.REQUEST_METADATA"));
      out.put("transaction_id", str(data, "com.squareup.pos.SERVER_TRANSACTION_ID"));
      out.put("client_transaction_id", str(data, "com.squareup.pos.CLIENT_TRANSACTION_ID"));
      out.put("error_code", str(data, "com.squareup.pos.ERROR_CODE"));
      out.put("error_description", str(data, "com.squareup.pos.ERROR_DESCRIPTION"));
    } else if (result.getResultCode() != Activity.RESULT_OK) {
      // Square came back with nothing at all. Deliberately NOT reported as a
      // cancel: the server treats an unknown code as "unconfirmed" and asks Square
      // whether the card actually went through before anyone can run it again.
      out.put("error_code", "NO_RESULT_DATA");
      out.put("error_description", "The Square app returned without a result.");
    }
    call.resolve(out);
  }
}
