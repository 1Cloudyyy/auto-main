package com.automain.plugin;

import com.soulfiremc.server.api.SoulFireAPI;
import net.fabricmc.api.ModInitializer;

public final class Main implements ModInitializer {
  @Override
  public void onInitialize() {
    SoulFireAPI.registerServerExtension(new AutoMainPlugin());
  }
}
