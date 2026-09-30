import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import pins
from esphome.components.esp32 import (
    add_idf_component,
    add_idf_sdkconfig_option,
    include_builtin_idf_component,
)
from esphome.const import CONF_ID

CODEOWNERS = ["@wewe-project"]
DEPENDENCIES = ["esp32", "wifi"]

CONF_SIGNAL_URL = "signal_url"
CONF_CLK_PIN = "clk_pin"
CONF_DIN_PIN = "din_pin"
CONF_MAX_LISTENERS = "max_listeners"
CONF_ICE_SERVERS = "ice_servers"
DEFAULT_ICE_SERVERS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]

def _stun_url(value):
    value = cv.string_strict(value)
    if not value.startswith("stun:"):
        raise cv.Invalid(
            f"'{value}' must start with 'stun:' — this component is STUN-only (see AGENTS.md); "
            "a scheme-less or turn: URL is silently ignored, not upgraded"
        )
    return value


wewe_monitor_ns = cg.esphome_ns.namespace("wewe_monitor")
WeweMonitor = wewe_monitor_ns.class_("WeweMonitor", cg.Component)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(WeweMonitor),
        cv.Required(CONF_SIGNAL_URL): cv.string_strict,
        cv.Required(CONF_CLK_PIN): pins.internal_gpio_output_pin_number,
        cv.Required(CONF_DIN_PIN): pins.internal_gpio_input_pin_number,
        cv.Optional(CONF_MAX_LISTENERS, default=3): cv.int_range(min=1, max=8),
        cv.Optional(CONF_ICE_SERVERS, default=DEFAULT_ICE_SERVERS): cv.All(
            cv.ensure_list(_stun_url), cv.Length(min=1)
        ),
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    cg.add(var.set_signal_url(config[CONF_SIGNAL_URL]))
    cg.add(var.set_clk_pin(config[CONF_CLK_PIN]))
    cg.add(var.set_din_pin(config[CONF_DIN_PIN]))
    cg.add_define("WEWE_MAX_LISTENERS", config[CONF_MAX_LISTENERS])

    for url in config[CONF_ICE_SERVERS]:
        cg.add(var.add_ice_server(url))

    # esp_peer directly, not esp_webrtc: esp_webrtc's own transitive
    # dependency tree does not currently resolve (tempotian/av_render, with
    # no version pin, wants espressif/esp_codec_dev ~1.4; esp_capture wants
    # ~2.0.0-beta1 — disjoint ranges, an upstream Espressif packaging
    # conflict, not something fixable from this project's manifest). Firmware
    # is built directly on esp_peer instead, mirroring esp-webrtc-solution's
    # own solutions/peer_demo/main/webrtc.c pattern — see
    # wewe_monitor.cpp's top-of-file comment for the full reasoning.
    add_idf_component(name="espressif/esp_peer", ref="1.5.5")

    # wewe_signaling.c's WebSocket transport — a direct dependency now
    # rather than transitive via esp_webrtc. cJSON ships as part of ESP-IDF
    # itself (components/json), but ESPHome excludes unused built-in IDF
    # components by default (2026.2.0+) to cut binary size, so it must be
    # opted back in explicitly.
    add_idf_component(name="espressif/esp_websocket_client", ref="~1.4.0")
    include_builtin_idf_component("json")

    # wewe_storage.c's persistent room id + authorized-listener list.
    include_builtin_idf_component("nvs_flash")

    # I2S PDM RX mic capture (wewe_mic.c) — also excluded by default.
    include_builtin_idf_component("esp_driver_i2s")

    # esp_peer's DTLS-SRTP code needs mbedTLS built with SRTP support, which
    # ESPHome's default sdkconfig does not enable (confirmed by the spike in
    # docs/superpowers/specs/2026-09-25-esphome-esp32-monitor-firmware-design.md).
    add_idf_sdkconfig_option("CONFIG_MBEDTLS_SSL_PROTO_DTLS", True)
    add_idf_sdkconfig_option("CONFIG_MBEDTLS_SSL_DTLS_SRTP", True)
    add_idf_sdkconfig_option("CONFIG_MBEDTLS_X509_CREATE_C", True)

    # esp_crt_bundle_attach (wewe_signaling.c) needs this on to actually have
    # a certificate bundle to verify wss:// against — forced explicitly
    # rather than trusting it's already ESPHome's default.
    add_idf_sdkconfig_option("CONFIG_MBEDTLS_CERTIFICATE_BUNDLE", True)
