package com.automain.plugin;

import com.soulfiremc.server.settings.lib.SettingsObject;
import com.soulfiremc.server.settings.lib.SettingsSource;
import com.soulfiremc.server.settings.property.BooleanProperty;
import com.soulfiremc.server.settings.property.ImmutableBooleanProperty;
import com.soulfiremc.server.settings.property.ImmutableIntProperty;
import com.soulfiremc.server.settings.property.ImmutableStringListProperty;
import com.soulfiremc.server.settings.property.ImmutableStringProperty;
import com.soulfiremc.server.settings.property.IntProperty;
import com.soulfiremc.server.settings.property.StringListProperty;
import com.soulfiremc.server.settings.property.StringProperty;
import lombok.AccessLevel;
import lombok.NoArgsConstructor;

import java.util.List;

/// Instance settings for the Auto-Main controller.
///
/// Keys are kebab-case and must stay in sync with `src/soulfire/settings.ts`
/// in the controller repository.
@NoArgsConstructor(access = AccessLevel.PRIVATE)
public final class AutoMainSettings implements SettingsObject {
  public static final String NAMESPACE = "auto-main";

  public static final BooleanProperty<SettingsSource.Instance> ENABLED =
    ImmutableBooleanProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("enabled")
      .uiName("Enable Auto-Main")
      .description("Expose Auto-Main settings for the controller")
      .defaultValue(true)
      .build();

  public static final BooleanProperty<SettingsSource.Instance> TEST_MODE =
    ImmutableBooleanProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("test-mode")
      .uiName("Test mode")
      .description("Skip base trips (drop, repair); stop when inventory and shulkers are full")
      .defaultValue(false)
      .build();

  public static final IntProperty<SettingsSource.Instance> PICKAXE_SLOT =
    ImmutableIntProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("pickaxe-slot")
      .uiName("Pickaxe hotbar slot")
      .description("Hotbar slot (1-9) where the bot keeps its pickaxe")
      .defaultValue(1)
      .minValue(1)
      .maxValue(9)
      .build();

  public static final StringProperty<SettingsSource.Instance> MINES_API_URL =
    ImmutableStringProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("mines-api-url")
      .uiName("Mines API URL")
      .description("Endpoint used by the mine dispatcher")
      .defaultValue("https://funtime.me/api/backend/api/v1/plugin/mines")
      .build();

  public static final StringProperty<SettingsSource.Instance> MINES_SERVER_TYPES =
    ImmutableStringProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("mines-server-types")
      .uiName("Server types filter")
      .description("Value of the server-types query parameter (all, 1xx,2xx, ...)")
      .defaultValue("all")
      .build();

  public static final IntProperty<SettingsSource.Instance> MINES_POLL_INTERVAL_MS =
    ImmutableIntProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("mines-poll-interval-ms")
      .uiName("Mines poll interval (ms)")
      .description("How often the dispatcher refreshes the mine list")
      .defaultValue(7000)
      .minValue(1000)
      .maxValue(600000)
      .build();

  public static final StringProperty<SettingsSource.Instance> HOME_COMMAND =
    ImmutableStringProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("home-command")
      .uiName("Clan home command")
      .description("Teleports the bot from the main anarchy to the base")
      .defaultValue("/clan home")
      .build();

  public static final StringProperty<SettingsSource.Instance> HOME_ANARCHY =
    ImmutableStringProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("home-anarchy")
      .uiName("Main anarchy")
      .description("Anarchy where the clan home is registered; never farmed")
      .defaultValue("302")
      .build();

  public static final StringProperty<SettingsSource.Instance> TARGET_STRATEGY =
    ImmutableStringProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("target-strategy")
      .uiName("Target strategy")
      .description("timer (arrive near reset) or round_robin")
      .defaultValue("timer")
      .build();

  public static final IntProperty<SettingsSource.Instance> TARGET_TRAVEL_MS =
    ImmutableIntProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("target-travel-ms")
      .uiName("Travel time (ms)")
      .description("Estimated /anN switch plus chunk load time")
      .defaultValue(25000)
      .minValue(0)
      .maxValue(300000)
      .build();

  public static final IntProperty<SettingsSource.Instance> TARGET_MIN_LEAD_MS =
    ImmutableIntProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("target-min-lead-ms")
      .uiName("Minimum lead (ms)")
      .description("Earliest acceptable reset time after arrival")
      .defaultValue(10000)
      .minValue(0)
      .maxValue(300000)
      .build();

  public static final IntProperty<SettingsSource.Instance> TARGET_MAX_LEAD_MS =
    ImmutableIntProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("target-max-lead-ms")
      .uiName("Maximum lead (ms)")
      .description("Latest acceptable reset time after arrival")
      .defaultValue(90000)
      .minValue(0)
      .maxValue(600000)
      .build();

  public static final StringListProperty<SettingsSource.Instance> TARGET_RARITY =
    ImmutableStringListProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("target-rarity")
      .uiName("Rarity priority")
      .description("Ordered rarity priority, best first")
      .addAllDefaultValue(List.of("legendary", "mythical", "default"))
      .build();

  public static final StringListProperty<SettingsSource.Instance> TARGET_ALLOW =
    ImmutableStringListProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("target-allow")
      .uiName("Allowed anarchies")
      .description("Allowlist (server key, number or name). Empty means all")
      .addAllDefaultValue(List.of())
      .build();

  public static final StringListProperty<SettingsSource.Instance> TARGET_DENY =
    ImmutableStringListProperty.<SettingsSource.Instance>builder()
      .sourceType(SettingsSource.Instance.INSTANCE)
      .namespace(NAMESPACE)
      .key("target-deny")
      .uiName("Denied anarchies")
      .description("Denylist (server key, number or name)")
      .addAllDefaultValue(List.of())
      .build();
}

