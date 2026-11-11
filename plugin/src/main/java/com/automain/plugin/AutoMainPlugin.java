package com.automain.plugin;

import com.soulfiremc.server.api.ExternalPlugin;
import com.soulfiremc.server.api.PluginInfo;
import com.soulfiremc.server.api.event.lifecycle.InstanceSettingsRegistryInitEvent;
import net.lenni0451.lambdaevents.EventHandler;

/// Registers the Auto-Main settings page on every instance.
///
/// The controller reads these values from the instance settings
/// (`auto-main` namespace) and never needs its own config file.
public final class AutoMainPlugin extends ExternalPlugin {
  public AutoMainPlugin() {
    super(new PluginInfo(
      "auto-main",
      "0.1.0",
      "Configuration surface for the Auto-Main mine farm controller",
      "1Cloudyyy",
      "MIT",
      "https://github.com/1Cloudyyy/auto-main"
    ));
  }

  @EventHandler
  public void onSettingsRegistryInit(InstanceSettingsRegistryInitEvent event) {
    event.settingsPageRegistry().addPluginPage(
      AutoMainSettings.class,
      "auto-main",
      "Auto-Main",
      this,
      "pickaxe",
      AutoMainSettings.ENABLED
    );
  }
}
