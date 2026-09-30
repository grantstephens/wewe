#include "wewe_monitor.h"
#include "esphome/core/log.h"
#include "esphome/components/network/util.h"

#include <cmath>
#include <cstring>

#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_peer.h"
#include "esp_peer_default.h"

#include "noise_gate.h"
#include "wewe_g711.h"
#include "wewe_invite_mode.h"
#include "wewe_mic.h"
#include "wewe_signaling.h"
#include "wewe_storage.h"

/*
 * Built directly on esp_peer (not esp_webrtc/esp_capture) — see the
 * previous revision of this file's history for why esp_webrtc's own
 * dependency tree doesn't resolve. This revision adds real pairing:
 * multi-listener support (one esp_peer connection per authorized Parent),
 * a persistent NVS-backed room id + authorized-listener list, and a
 * rotating, expiring invite code registered as a signal-server alias —
 * porting src/webrtc/monitorSession.ts's actual behavior (not the
 * now-superseded docs/superpowers/specs/2026-09-24-multi-listener-invite-
 * gated-pairing-design.md, which predates the alias-based redesign in
 * docs/superpowers/specs/2026-09-25-ephemeral-rotating-pairing-codes-design.md
 * — read the real MonitorSession.ts source, not just the spec, since the
 * spec was stale relative to it).
 *
 * wewe_signaling is intentionally NOT built on the vendored
 * esp_peer_signaling_impl_t abstraction anymore: that shape has no
 * `deviceId` in any of its callbacks, because it was designed for
 * esp_webrtc's single-Monitor-single-Parent demos. This firmware's
 * wewe_signaling.h carries device_id through every callback directly,
 * mirroring MonitorSession.ts's own onPeerJoined(deviceId)/
 * onPeerLeft(deviceId)/onSignal(payload, from) shape.
 *
 * Pairing mode is armed by on_pair_tapped() — wired from the touchscreen
 * (a full-screen touch binary_sensor's on_press:, see spike.yaml) calling
 * id(wewe).on_pair_tapped(). The display: lambda reads current_code()/
 * seconds_remaining()/connected_listener_count() to render the screen.
 */

namespace esphome {
namespace wewe_monitor {

static const char *const TAG = "wewe_monitor";

namespace {

#define MAX_LISTENERS 3
constexpr int64_t INVITE_WINDOW_MS = 60 * 1000;  // matches MonitorSession.ts's INVITE_WINDOW_MS

struct Listener {
  bool in_use = false;
  char device_id[WEWE_ID_HEX_LEN + 1] = {};
  esp_peer_handle_t peer = nullptr;
  bool next_outgoing_is_offer = false;
  // Set by peer_state_handler (ESP_PEER_STATE_DISCONNECTED/CONNECT_FAILED)
  // or on_peer_left (relay-reported peer-left, runs on websocket_task) —
  // never acted on from either caller directly. pc_pump_task is the only
  // task ever allowed to call esp_peer_close()/esp_peer_open() for a given
  // listener; a prior version had on_peer_left call teardown_peer()
  // directly, racing pc_pump_task's own teardown for the same listener
  // with no synchronization — landed as a spinlock assertion deep in
  // esp_peer's own mutex ("lock->count == 0"), a corrupted/already-freed
  // lock, the signature of a double-close.
  //
  // Deliberately teardown-only, no auto-recreate: an earlier version also
  // had peer_state_handler set a needs_rebuild flag that reopened a peer
  // and sent it a fresh, unsolicited SDP offer on any local ICE/DTLS
  // failure — proactively "reconnecting" to a Parent that never asked for
  // it. Real, reproduced: the Parent app has no code path to accept an
  // unsolicited offer (it only ever connects when a human enters a pairing
  // code), so that offer just retried a DTLS handshake against a phone
  // that had already moved on — the exact PEER_CLOSE_NOTIFY/timeout loop
  // this was meant to fix, self-inflicted. The phone reconnecting to an
  // already-authorized Monitor (see on_peer_joined's authorized-listener
  // check) is the correct direction for this to happen in, matching how
  // the very first connection already works — not the Monitor guessing
  // when to push a fresh offer at a Parent that may not be listening.
  bool needs_teardown = false;
};

struct RuntimeState {
  char room_id[WEWE_ID_HEX_LEN + 1] = {};
  Listener listeners[MAX_LISTENERS];
  wewe_invite_mode_t invite_mode = {};
  char current_code[7] = {};  // 6 digits + null; empty string = no active code
  int64_t code_expires_at_ms = 0;
  bool local_should_show_code = false;
  esp_timer_handle_t invite_timer = nullptr;

  noise_gate_t gate = {};
  volatile bool peer_task_running = false;
  volatile bool send_task_running = false;
  int64_t frame_seq = 0;

  // 0 = never happened yet (screen starts "on" from setup(); no sound
  // observed until the gate first opens).
  int64_t last_activity_ms = 0;
  int64_t last_sound_ms = 0;

  // Set by on_screen_touched() when a tap arrives while the screen was
  // off; consumed by on_pair_tapped() so that the tap which merely wakes
  // the display doesn't also arm a fresh pairing code — same two-step
  // convention as a phone lock screen. Both handlers fire from the same
  // physical touch report within the same loop() pass, so the ~500ms
  // window comfortably covers the gap between them regardless of which
  // binary_sensor's on_press runs first.
  bool pending_wake_only = false;
  int64_t pending_wake_only_ms = 0;
};

RuntimeState g_state;

constexpr int64_t SCREEN_TIMEOUT_MS = 20 * 1000;

double pcm_rms_dbfs(const int16_t *samples, int count) {
  double sum_sq = 0;
  for (int i = 0; i < count; i++) {
    double s = samples[i] / 32768.0;
    sum_sq += s * s;
  }
  double rms = count > 0 ? sqrt(sum_sq / count) : 0.0;
  if (rms < 1e-9) {
    return -90.0;
  }
  double db = 20.0 * log10(rms);
  return db < -90.0 ? -90.0 : db;
}

char *bounded_copy(const uint8_t *data, int size) {
  char *out = (char *)malloc((size_t)size + 1);
  if (out == nullptr) {
    return nullptr;
  }
  memcpy(out, data, (size_t)size);
  out[size] = '\0';
  return out;
}

Listener *find_listener(const char *device_id) {
  for (auto &l : g_state.listeners) {
    if (l.in_use && strcmp(l.device_id, device_id) == 0) {
      return &l;
    }
  }
  return nullptr;
}

Listener *alloc_listener(const char *device_id) {
  for (auto &l : g_state.listeners) {
    if (!l.in_use) {
      l = Listener{};
      l.in_use = true;
      strncpy(l.device_id, device_id, sizeof(l.device_id) - 1);
      return &l;
    }
  }
  return nullptr;
}

int active_listener_count() {
  int n = 0;
  for (auto &l : g_state.listeners) {
    if (l.in_use) n++;
  }
  return n;
}

void send_sdp(Listener *l, const char *sdp_text, bool is_offer) {
  cJSON *payload = cJSON_CreateObject();
  cJSON *sdp = cJSON_CreateObject();
  cJSON_AddStringToObject(sdp, "sdp", sdp_text);
  cJSON_AddStringToObject(sdp, "type", is_offer ? "offer" : "answer");
  cJSON_AddItemToObject(payload, "sdp", sdp);
  wewe_signaling_send(l->device_id, payload);
  cJSON_Delete(payload);
}

void send_candidate(Listener *l, const char *candidate_text) {
  cJSON *payload = cJSON_CreateObject();
  cJSON *candidate = cJSON_CreateObject();
  cJSON_AddStringToObject(candidate, "candidate", candidate_text);
  cJSON_AddItemToObject(payload, "candidate", candidate);
  wewe_signaling_send(l->device_id, payload);
  cJSON_Delete(payload);
}

void broadcast_invite_code() {
  const char *code = g_state.current_code[0] != '\0' ? g_state.current_code : nullptr;
  ESP_LOGI(TAG, "Invite code: %s", code != nullptr ? code : "(none)");
  for (int i = 0; i < g_state.invite_mode.count; i++) {
    const char *holder = g_state.invite_mode.holders[i];
    if (strcmp(holder, WEWE_INVITE_MODE_LOCAL_HOLDER) == 0) {
      continue;  // "local" isn't a signaling peer; the LCD (a later step) reads current_code directly
    }
    cJSON *payload = cJSON_CreateObject();
    if (code != nullptr) {
      cJSON_AddStringToObject(payload, "inviteCode", code);
    } else {
      cJSON_AddNullToObject(payload, "inviteCode");
    }
    wewe_signaling_send(holder, payload);
    cJSON_Delete(payload);
  }
}

void expire_invite() {
  g_state.current_code[0] = '\0';
  g_state.code_expires_at_ms = 0;
  g_state.local_should_show_code = false;
  wewe_invite_mode_close(&g_state.invite_mode, WEWE_INVITE_MODE_LOCAL_HOLDER);
  // Close every remaining holder too — letting the window elapse closes
  // invite mode for everyone currently holding it open, not just whoever
  // started the clock (matches MonitorSession.ts's expireInvite exactly).
  while (g_state.invite_mode.count > 0) {
    wewe_invite_mode_close(&g_state.invite_mode, g_state.invite_mode.holders[0]);
  }
  broadcast_invite_code();
}

void invite_timer_cb(void *arg) { expire_invite(); }

void arm_invite() {
  for (int i = 0; i < 6; i++) {
    g_state.current_code[i] = (char)('0' + (esp_random() % 10));
  }
  g_state.current_code[6] = '\0';
  g_state.code_expires_at_ms = esp_timer_get_time() / 1000 + INVITE_WINDOW_MS;
  wewe_signaling_set_alias(g_state.current_code);
  broadcast_invite_code();

  if (g_state.invite_timer == nullptr) {
    esp_timer_create_args_t args = {};
    args.callback = invite_timer_cb;
    args.name = "wewe_invite";
    esp_timer_create(&args, &g_state.invite_timer);
  } else {
    esp_timer_stop(g_state.invite_timer);
  }
  esp_timer_start_once(g_state.invite_timer, (uint64_t)INVITE_WINDOW_MS * 1000);
}

// Call from the (future) touchscreen "Pair" button — an explicit local
// action, always shows the code on this device's own screen. See
// MonitorSession.ts's rearmInvite doc comment.
void rearm_invite() {
  wewe_invite_mode_open(&g_state.invite_mode, WEWE_INVITE_MODE_LOCAL_HOLDER);
  g_state.local_should_show_code = true;
  arm_invite();
}

// An already-connected, authorized Parent asked to open invite mode on the
// Monitor's behalf. Reuses the currently-live code rather than clobbering
// whatever's already showing.
void ensure_invite_armed(const char *holder) {
  wewe_invite_mode_open(&g_state.invite_mode, holder);
  if (g_state.current_code[0] == '\0') {
    g_state.local_should_show_code = false;
    arm_invite();
  } else {
    cJSON *payload = cJSON_CreateObject();
    cJSON_AddStringToObject(payload, "inviteCode", g_state.current_code);
    wewe_signaling_send(holder, payload);
    cJSON_Delete(payload);
  }
}

int peer_state_handler(esp_peer_state_t state, void *ctx) {
  auto *l = (Listener *)ctx;
  ESP_LOGI(TAG, "esp_peer state for %.8s...: %d", l->device_id, (int)state);
  if (state == ESP_PEER_STATE_CONNECTED) {
    // Once anyone is actually connected, stop showing the code — matches
    // MonitorSession.ts's onconnectionstatechange doing the same the
    // instant countConnected() > 0. expire_invite is a no-op once
    // current_code is already empty, so later churn doesn't re-fire it.
    if (g_state.current_code[0] != '\0') {
      expire_invite();
    }
  } else if (state == ESP_PEER_STATE_DISCONNECTED || state == ESP_PEER_STATE_CONNECT_FAILED) {
    // Real, reproduced: esp_peer's own "Try to rebuild connection" recovery
    // (peer_default.c, not our code) got stuck indefinitely after a WiFi
    // roam changed the Monitor's local IP mid-call. Don't trust that path
    // either — but don't auto-recreate a peer here (see needs_teardown's
    // doc comment for why a Monitor-initiated unsolicited re-offer is the
    // wrong direction). Clean up and go back to idle; the Parent
    // reconnecting — an already-authorized device rejoining the room — is
    // what brings this listener back, same as the very first connection.
    l->needs_teardown = true;
  }
  return 0;
}

int peer_msg_handler(esp_peer_msg_t *msg, void *ctx) {
  auto *l = (Listener *)ctx;
  char *bounded = bounded_copy(msg->data, msg->size);
  if (bounded == nullptr) {
    return -1;
  }
  if (msg->type == ESP_PEER_MSG_TYPE_SDP) {
    send_sdp(l, bounded, l->next_outgoing_is_offer);
    l->next_outgoing_is_offer = false;
  } else if (msg->type == ESP_PEER_MSG_TYPE_CANDIDATE) {
    send_candidate(l, bounded);
  }
  free(bounded);
  return 0;
}

int peer_audio_info_handler(esp_peer_audio_stream_info_t *info, void *ctx) { return 0; }
int peer_video_info_handler(esp_peer_video_stream_info_t *info, void *ctx) { return 0; }
int peer_audio_data_handler(esp_peer_audio_frame_t *frame, void *ctx) { return 0; }  // SEND_ONLY: shouldn't fire
int peer_video_data_handler(esp_peer_video_frame_t *frame, void *ctx) { return 0; }

// Forward-declared: defined below, needed by pc_pump_task's needs_teardown
// handling above its definition in file order.
void teardown_peer(const char *device_id);

void pc_pump_task(void *arg) {
  while (g_state.peer_task_running) {
    for (auto &l : g_state.listeners) {
      if (!l.in_use || l.peer == nullptr) {
        continue;
      }

      // pc_pump_task is the only task allowed to call
      // esp_peer_close()/esp_peer_open() for a listener (see
      // needs_teardown's doc comment) — checked, and acted on, before
      // pumping this iteration's esp_peer_main_loop() at all, not nested
      // inside it.
      if (l.needs_teardown) {
        char device_id[WEWE_ID_HEX_LEN + 1];
        strncpy(device_id, l.device_id, sizeof(device_id) - 1);
        device_id[sizeof(device_id) - 1] = '\0';
        teardown_peer(device_id);
        continue;
      }

      esp_peer_main_loop(l.peer);
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
  vTaskDelete(nullptr);
}

void audio_send_task(void *arg) {
  const int sample_rate = 8000;
  const int frame_ms = 20;
  const int samples_per_frame = sample_rate * frame_ms / 1000;  // 160
  int16_t pcm[samples_per_frame];
  uint8_t encoded[samples_per_frame];

  while (g_state.send_task_running) {
    if (wewe_mic_read(pcm, samples_per_frame, frame_ms * 3) != 0) {
      vTaskDelay(pdMS_TO_TICKS(frame_ms));
      continue;
    }

    double level_db = pcm_rms_dbfs(pcm, samples_per_frame);
    int64_t now_ms = esp_timer_get_time() / 1000;
    bool open = noise_gate_push(&g_state.gate, level_db, now_ms);

    if (open) {
      g_state.last_sound_ms = now_ms;
      for (int i = 0; i < samples_per_frame; i++) {
        encoded[i] = wewe_linear_to_alaw(pcm[i]);
      }
      // One shared mic/gate feeds every connected listener, matching
      // MonitorSession.ts's one localStream track added to every
      // RTCPeerConnection — the same gated frame goes to each of them.
      for (auto &l : g_state.listeners) {
        if (l.in_use && l.peer != nullptr) {
          esp_peer_audio_frame_t frame = {};
          frame.data = encoded;
          frame.size = samples_per_frame;
          frame.pts = (uint32_t)(g_state.frame_seq * frame_ms);
          esp_peer_send_audio(l.peer, &frame);
        }
      }
      g_state.frame_seq++;
    }
  }
  vTaskDelete(nullptr);
}

void create_peer_for(const char *device_id) {
  if (find_listener(device_id) != nullptr) {
    return;  // already connected (e.g. a signaling-level reconnect)
  }
  Listener *l = alloc_listener(device_id);
  if (l == nullptr) {
    ESP_LOGW(TAG, "Max listeners (%d) reached, dropping %.8s...", MAX_LISTENERS, device_id);
    return;
  }
  l->next_outgoing_is_offer = true;

  // STUN-only, matching src/webrtc/rtcConfig.ts's DEFAULT_ICE_SERVERS.
  static esp_peer_ice_server_cfg_t ice_servers[] = {
      {.stun_url = (char *)"stun:stun.l.google.com:19302", .user = nullptr, .psw = nullptr},
      {.stun_url = (char *)"stun:stun1.l.google.com:19302", .user = nullptr, .psw = nullptr},
  };

  esp_peer_cfg_t cfg = {};
  cfg.server_lists = ice_servers;
  cfg.server_num = 2;
  // MonitorSession is "always the offerer for each Parent that joins,
  // since it's the side with media to send" — every listener connection
  // is controlling, unconditionally, no is_initiator ambiguity at all.
  cfg.role = ESP_PEER_ROLE_CONTROLLING;
  cfg.audio_dir = ESP_PEER_MEDIA_DIR_SEND_ONLY;
  cfg.video_dir = ESP_PEER_MEDIA_DIR_NONE;
  cfg.audio_info.codec = ESP_PEER_AUDIO_CODEC_G711A;
  cfg.audio_info.sample_rate = 8000;
  cfg.audio_info.channel = 1;
  cfg.on_state = peer_state_handler;
  cfg.on_msg = peer_msg_handler;
  cfg.on_audio_info = peer_audio_info_handler;
  cfg.on_video_info = peer_video_info_handler;
  cfg.on_audio_data = peer_audio_data_handler;
  cfg.on_video_data = peer_video_data_handler;
  cfg.ctx = l;

  int ret = esp_peer_open(&cfg, esp_peer_get_default_impl(), &l->peer);
  if (ret != ESP_PEER_ERR_NONE) {
    ESP_LOGE(TAG, "esp_peer_open failed for %.8s...: %d", device_id, ret);
    l->in_use = false;
    return;
  }
  esp_peer_new_connection(l->peer);

  if (!g_state.peer_task_running) {
    g_state.peer_task_running = true;
    // Real, reproduced crash at 6144: FreeRTOS's own stack-overflow
    // detector fired here (`vApplicationStackOverflowHook`), not a guess —
    // a preceding heap-corruption assert on an earlier connection attempt
    // was almost certainly the same overflow, just caught a moment later
    // by a different guard. The call chain that overflowed it nests STUN
    // agent processing (agent_process_stun_request -> stun_msg_is_valid ->
    // utils_get_hmac_sha1 -> mbedtls_md_setup) inside an active DTLS
    // handshake (dtls_recv -> ... -> mbedtls_ssl_handshake_server_step),
    // both live in the same esp_peer_main_loop() iteration — deeper than
    // either alone. 16KB matches what mbedtls-handshake-capable ESP32
    // tasks commonly need; this only happens once a real Parent actually
    // connects, which nothing before this session's live phone testing had
    // exercised.
    xTaskCreate(pc_pump_task, "wewe_pc_pump", 16384, nullptr, 5, nullptr);
  }
}

void teardown_peer(const char *device_id) {
  Listener *l = find_listener(device_id);
  if (l == nullptr) {
    return;
  }
  if (l->peer != nullptr) {
    esp_peer_close(l->peer);
  }
  l->in_use = false;
}

void on_peer_joined(const char *device_id, void *ctx) {
  bool authorized = wewe_storage_is_listener_authorized(device_id);
  wewe_listener_decision_t decision = wewe_decide_listener(authorized, wewe_invite_mode_is_open(&g_state.invite_mode));

  if (decision == WEWE_LISTENER_REJECT) {
    ESP_LOGI(TAG, "Rejecting unauthorized %.8s... (invite mode closed)", device_id);
    cJSON *payload = cJSON_CreateObject();
    cJSON_AddBoolToObject(payload, "rejected", true);
    cJSON_AddStringToObject(payload, "reason", "not-authorized");
    wewe_signaling_send(device_id, payload);
    cJSON_Delete(payload);
    return;
  }
  if (decision == WEWE_LISTENER_ACCEPT_NEW) {
    wewe_storage_authorize_listener(device_id);
    ESP_LOGI(TAG, "Authorized new listener %.8s...", device_id);
  }
  create_peer_for(device_id);
}

void on_peer_left(const char *device_id, void *ctx) {
  // Doesn't call teardown_peer()/esp_peer_close() directly — this runs on
  // websocket_task, and only pc_pump_task may touch a Listener's esp_peer
  // handle (see needs_teardown's doc comment for the crash that taught
  // this). wewe_invite_mode_close is pure local bookkeeping, safe from any
  // task.
  Listener *l = find_listener(device_id);
  if (l != nullptr) {
    l->needs_teardown = true;
  }
  wewe_invite_mode_close(&g_state.invite_mode, device_id);
}

void on_signal(const char *from, cJSON *payload, void *ctx) {
  cJSON *invite_mode = cJSON_GetObjectItem(payload, "inviteMode");
  if (cJSON_IsString(invite_mode)) {
    // Only an already-connected (and therefore already-authorized) peer
    // may toggle invite mode on the Monitor's behalf.
    if (find_listener(from) == nullptr) {
      return;
    }
    if (strcmp(invite_mode->valuestring, "open") == 0) {
      ensure_invite_armed(from);
    } else {
      wewe_invite_mode_close(&g_state.invite_mode, from);
    }
    return;
  }

  Listener *l = find_listener(from);
  if (l == nullptr) {
    return;  // not (yet) an accepted listener — sdp/candidate only makes sense for one
  }

  cJSON *sdp = cJSON_GetObjectItem(payload, "sdp");
  if (cJSON_IsObject(sdp)) {
    cJSON *sdp_text = cJSON_GetObjectItem(sdp, "sdp");
    cJSON *sdp_type = cJSON_GetObjectItem(sdp, "type");
    if (cJSON_IsString(sdp_text)) {
      if (cJSON_IsString(sdp_type) && strcmp(sdp_type->valuestring, "offer") == 0) {
        l->next_outgoing_is_offer = false;
      }
      esp_peer_msg_t msg = {};
      msg.type = ESP_PEER_MSG_TYPE_SDP;
      msg.data = (uint8_t *)sdp_text->valuestring;
      msg.size = (int)strlen(sdp_text->valuestring);
      esp_peer_send_msg(l->peer, &msg);
    }
    return;
  }
  cJSON *candidate = cJSON_GetObjectItem(payload, "candidate");
  if (cJSON_IsObject(candidate)) {
    cJSON *cand_text = cJSON_GetObjectItem(candidate, "candidate");
    if (cJSON_IsString(cand_text)) {
      esp_peer_msg_t msg = {};
      msg.type = ESP_PEER_MSG_TYPE_CANDIDATE;
      msg.data = (uint8_t *)cand_text->valuestring;
      msg.size = (int)strlen(cand_text->valuestring);
      esp_peer_send_msg(l->peer, &msg);
    }
  }
}

void on_error(const char *message, void *ctx) { ESP_LOGW(TAG, "Signaling error: %s", message); }

void on_joined(void *ctx) { ESP_LOGI(TAG, "Joined signaling room; tap the screen to pair"); }

}  // namespace

void WeweMonitor::on_pair_tapped() {
  int64_t now_ms = esp_timer_get_time() / 1000;

  if (g_state.pending_wake_only && (now_ms - g_state.pending_wake_only_ms) < 500) {
    // This tap is the one that just woke the screen (on_screen_touched()
    // set the flag below) — consume it and stop, don't also arm pairing.
    g_state.pending_wake_only = false;
    return;
  }

  // Real, reproduced bug: a single physical tap fired on_press twice
  // (~500ms apart — touchscreen jitter, not a code issue), each rearming
  // with a fresh code and clobbering the previous one's alias. Debounce.
  static int64_t last_tap_ms = 0;
  if (now_ms - last_tap_ms < 1000) {
    return;
  }
  last_tap_ms = now_ms;
  rearm_invite();
}

void WeweMonitor::on_screen_touched() {
  int64_t now_ms = esp_timer_get_time() / 1000;
  bool was_off = (now_ms - g_state.last_activity_ms) >= SCREEN_TIMEOUT_MS;
  g_state.last_activity_ms = now_ms;
  if (was_off) {
    g_state.pending_wake_only = true;
    g_state.pending_wake_only_ms = now_ms;
  }
}

bool WeweMonitor::is_screen_on() const {
  int64_t now_ms = esp_timer_get_time() / 1000;
  return (now_ms - g_state.last_activity_ms) < SCREEN_TIMEOUT_MS;
}

int WeweMonitor::seconds_since_last_sound() const {
  if (g_state.last_sound_ms == 0) {
    return -1;
  }
  int64_t now_ms = esp_timer_get_time() / 1000;
  return (int)((now_ms - g_state.last_sound_ms) / 1000);
}

std::string WeweMonitor::current_code() const { return std::string(g_state.current_code); }

int WeweMonitor::seconds_remaining() const {
  if (g_state.current_code[0] == '\0') {
    return 0;
  }
  int64_t now_ms = esp_timer_get_time() / 1000;
  int64_t remaining_ms = g_state.code_expires_at_ms - now_ms;
  return remaining_ms > 0 ? (int)(remaining_ms / 1000) : 0;
}

int WeweMonitor::connected_listener_count() const { return active_listener_count(); }

void WeweMonitor::setup() {
  noise_gate_init(&g_state.gate, nullptr);
  wewe_invite_mode_init(&g_state.invite_mode);

  // Screen starts "on" for the initial timeout window from boot.
  g_state.last_activity_ms = esp_timer_get_time() / 1000;

  if (wewe_storage_get_or_create_room_id(g_state.room_id, sizeof(g_state.room_id)) != 0) {
    ESP_LOGE(TAG, "Failed to get/create persistent room id");
    this->mark_failed();
    return;
  }

  if (wewe_mic_init(8000) != 0) {
    ESP_LOGE(TAG, "wewe_mic_init failed — no audio will be captured");
  } else {
    g_state.send_task_running = true;
    // Bumped alongside wewe_pc_pump's stack: esp_peer_send_audio() flows
    // through the same SRTP/mbedtls-backed encrypt path, not confirmed to
    // have overflowed itself but sharing the same risk profile.
    xTaskCreate(audio_send_task, "wewe_audio_send", 8192, nullptr, 5, nullptr);
  }
}

void WeweMonitor::loop() {
  // See the earlier crash this fixed: component setup() calls aren't
  // network-ordered, so signaling can't start until WiFi/network is
  // actually up.
  if (!this->started_) {
    if (!network::is_connected()) {
      return;
    }
    this->started_ = true;
    this->start_signaling_();
    return;
  }
  // Services a pending restart after a clean server-initiated WebSocket
  // close — see wewe_signaling.c's WEBSOCKET_EVENT_CLOSED case for why
  // this has to happen from a different task than the signaling client's
  // own, which Component::loop() (the main app task) naturally is.
  wewe_signaling_poll();
}

void WeweMonitor::start_signaling_() {
  static wewe_signaling_callbacks_t callbacks;
  callbacks.on_joined = on_joined;
  callbacks.on_peer_joined = on_peer_joined;
  callbacks.on_peer_left = on_peer_left;
  callbacks.on_signal = on_signal;
  callbacks.on_error = on_error;
  callbacks.ctx = this;

  if (wewe_signaling_start(this->signal_url_.c_str(), g_state.room_id, &callbacks) != 0) {
    ESP_LOGE(TAG, "wewe_signaling_start failed");
    this->mark_failed();
    return;
  }

  ESP_LOGCONFIG(TAG, "Signaling started via %s, room %.8s...", this->signal_url_.c_str(), g_state.room_id);
  // Pairing mode arms itself from on_joined, once the connection is
  // actually confirmed up — not eagerly here (wewe_signaling_start only
  // kicks off an async connection; sending before it's truly open hit
  // esp_websocket_client with "not connected", a real, reproduced bug).
}

void WeweMonitor::dump_config() {
  ESP_LOGCONFIG(TAG, "Wewe WebRTC spike component");
  ESP_LOGCONFIG(TAG, "  Signal URL: %s", this->signal_url_.c_str());
  ESP_LOGCONFIG(TAG, "  Room id: %.8s...", g_state.room_id);
}

}  // namespace wewe_monitor
}  // namespace esphome
