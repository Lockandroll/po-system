package com.lockandroll.nova;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Must be registered BEFORE super.onCreate so the bridge picks it up.
    registerPlugin(SquarePosPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
